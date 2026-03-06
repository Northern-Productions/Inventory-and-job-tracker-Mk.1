-- Raw CSV import support for migrating legacy Google Sheets exports into app.*
-- Run this after 0001_supabase_inventory_schema.sql.
--
-- Workflow:
-- 1. Import legacy CSVs into the import.*_raw tables below.
-- 2. Run: select import.load_inventory_from_staging('<org_uuid>');
-- 3. Optional cleanup: select import.clear_staging();

create schema if not exists import;

create table if not exists import.film_data_raw (
  "FilmKey" text,
  "Manufacturer" text,
  "FilmName" text,
  "SqFtWeightLbsPerSqFt" text,
  "DefaultCoreType" text,
  "SourceWidthIn" text,
  "SourceInitialFeet" text,
  "SourceInitialWeightLbs" text,
  "UpdatedAt" text,
  "SourceBoxId" text,
  "Notes" text
);

create table if not exists import.boxes_raw (
  "BoxID" text,
  "Manufacturer" text,
  "FilmName" text,
  "WidthIn" text,
  "InitialFeet" text,
  "FeetAvailable" text,
  "LotRun" text,
  "Status" text,
  "OrderDate" text,
  "ReceivedDate" text,
  "InitialWeightLbs" text,
  "LastRollWeightLbs" text,
  "LastWeighedDate" text,
  "FilmKey" text,
  "CoreType" text,
  "CoreWeightLbs" text,
  "LfWeightLbsPerFt" text,
  "PurchaseCost" text,
  "Notes" text,
  "HasEverBeenCheckedOut" text,
  "LastCheckoutJob" text,
  "LastCheckoutDate" text,
  "ZeroedDate" text,
  "ZeroedReason" text,
  "ZeroedBy" text
);

create table if not exists import.allocations_raw (
  "AllocationID" text,
  "BoxID" text,
  "Warehouse" text,
  "JobNumber" text,
  "JobDate" text,
  "AllocatedFeet" text,
  "Status" text,
  "CreatedAt" text,
  "CreatedBy" text,
  "ResolvedAt" text,
  "ResolvedBy" text,
  "Notes" text,
  "CrewLeader" text,
  "FilmOrderID" text
);

create table if not exists import.film_orders_raw (
  "FilmOrderID" text,
  "JobNumber" text,
  "Warehouse" text,
  "Manufacturer" text,
  "FilmName" text,
  "WidthIn" text,
  "RequestedFeet" text,
  "CoveredFeet" text,
  "OrderedFeet" text,
  "RemainingToOrderFeet" text,
  "JobDate" text,
  "CrewLeader" text,
  "Status" text,
  "SourceBoxID" text,
  "CreatedAt" text,
  "CreatedBy" text,
  "ResolvedAt" text,
  "ResolvedBy" text,
  "Notes" text
);

create table if not exists import.film_order_box_links_raw (
  "LinkID" text,
  "FilmOrderID" text,
  "BoxID" text,
  "OrderedFeet" text,
  "AutoAllocatedFeet" text,
  "CreatedAt" text,
  "CreatedBy" text
);

create table if not exists import.jobs_raw (
  "JobNumber" text,
  "Warehouse" text,
  "Sections" text,
  "DueDate" text,
  "LifecycleStatus" text,
  "CreatedAt" text,
  "CreatedBy" text,
  "UpdatedAt" text,
  "UpdatedBy" text,
  "Notes" text
);

create table if not exists import.job_requirements_raw (
  "RequirementID" text,
  "JobNumber" text,
  "Manufacturer" text,
  "FilmName" text,
  "WidthIn" text,
  "RequiredFeet" text,
  "CreatedAt" text,
  "CreatedBy" text,
  "UpdatedAt" text,
  "UpdatedBy" text,
  "Notes" text
);

create table if not exists import.audit_log_raw (
  "LogID" text,
  "Date" text,
  "Action" text,
  "BoxID" text,
  "Before" text,
  "After" text,
  "User" text,
  "Notes" text
);

create table if not exists import.roll_weight_log_raw (
  "LogID" text,
  "BoxID" text,
  "Warehouse" text,
  "Manufacturer" text,
  "FilmName" text,
  "WidthIn" text,
  "JobNumber" text,
  "CheckedOutAt" text,
  "CheckedOutBy" text,
  "CheckedOutWeightLbs" text,
  "CheckedInAt" text,
  "CheckedInBy" text,
  "CheckedInWeightLbs" text,
  "WeightDeltaLbs" text,
  "FeetBefore" text,
  "FeetAfter" text,
  "Notes" text
);

create or replace function import.to_bool(value text)
returns boolean
language sql
immutable
as $$
  select lower(trim(coalesce(value, ''))) in ('true', '1', 'yes', 'y');
$$;

create or replace function import.clear_staging()
returns void
language plpgsql
as $$
begin
  truncate table
    import.film_data_raw,
    import.boxes_raw,
    import.allocations_raw,
    import.film_orders_raw,
    import.film_order_box_links_raw,
    import.jobs_raw,
    import.job_requirements_raw,
    import.audit_log_raw,
    import.roll_weight_log_raw;
end;
$$;

create or replace function import.load_inventory_from_staging(target_org_id uuid)
returns void
language plpgsql
as $$
begin
  if not exists (
    select 1
    from app.organizations
    where id = target_org_id
  ) then
    raise exception 'Organization % does not exist in app.organizations', target_org_id;
  end if;

  delete from app.audit_log where org_id = target_org_id;
  delete from app.roll_weight_log where org_id = target_org_id;
  delete from app.film_order_box_links where org_id = target_org_id;
  delete from app.allocations where org_id = target_org_id;
  delete from app.film_orders where org_id = target_org_id;
  delete from app.job_requirements where org_id = target_org_id;
  delete from app.jobs where org_id = target_org_id;
  delete from app.boxes where org_id = target_org_id;
  delete from app.film_catalog where org_id = target_org_id;

  insert into app.film_catalog (
    id,
    org_id,
    film_key,
    manufacturer,
    film_name,
    sq_ft_weight_lbs_per_sq_ft,
    default_core_type,
    source_width_in,
    source_initial_feet,
    source_initial_weight_lbs,
    source_box_id,
    notes,
    updated_at
  )
  select
    gen_random_uuid(),
    target_org_id,
    coalesce(nullif(trim("FilmKey"), ''), upper(trim("Manufacturer")) || '|' || upper(trim("FilmName"))),
    trim("Manufacturer"),
    trim("FilmName"),
    nullif(trim("SqFtWeightLbsPerSqFt"), '')::numeric(12, 8),
    coalesce(nullif(trim("DefaultCoreType"), ''), ''),
    nullif(trim("SourceWidthIn"), '')::numeric(10, 4),
    nullif(trim("SourceInitialFeet"), '')::integer,
    nullif(trim("SourceInitialWeightLbs"), '')::numeric(12, 2),
    coalesce(trim("SourceBoxId"), ''),
    coalesce(trim("Notes"), ''),
    coalesce(nullif(trim("UpdatedAt"), '')::timestamptz, now())
  from import.film_data_raw
  where coalesce(trim("Manufacturer"), '') <> ''
    and coalesce(trim("FilmName"), '') <> '';

  insert into app.boxes (
    id,
    org_id,
    box_id,
    warehouse,
    manufacturer,
    film_name,
    width_in,
    initial_feet,
    feet_available,
    lot_run,
    status,
    order_date,
    received_date,
    initial_weight_lbs,
    last_roll_weight_lbs,
    last_weighed_date,
    film_key,
    core_type,
    core_weight_lbs,
    lf_weight_lbs_per_ft,
    purchase_cost,
    notes,
    has_ever_been_checked_out,
    last_checkout_job,
    last_checkout_date,
    zeroed_date,
    zeroed_reason,
    zeroed_by
  )
  select
    gen_random_uuid(),
    target_org_id,
    trim("BoxID"),
    case when upper(left(trim("BoxID"), 1)) = 'M' then 'MS' else 'IL' end::app.warehouse,
    trim("Manufacturer"),
    trim("FilmName"),
    nullif(trim("WidthIn"), '')::numeric(10, 4),
    nullif(trim("InitialFeet"), '')::integer,
    coalesce(nullif(trim("FeetAvailable"), '')::integer, 0),
    coalesce(trim("LotRun"), ''),
    (
      case
        when upper(trim(coalesce("Status", ''))) in ('ORDERED', 'IN_STOCK', 'CHECKED_OUT', 'ZEROED', 'RETIRED')
          then upper(trim("Status"))
        when nullif(trim("ReceivedDate"), '') is not null and nullif(trim("ReceivedDate"), '')::date <= current_date
          then 'IN_STOCK'
        else 'ORDERED'
      end
    )::app.box_status,
    nullif(trim("OrderDate"), '')::date,
    nullif(trim("ReceivedDate"), '')::date,
    nullif(trim("InitialWeightLbs"), '')::numeric(12, 2),
    nullif(trim("LastRollWeightLbs"), '')::numeric(12, 2),
    nullif(trim("LastWeighedDate"), '')::date,
    coalesce(nullif(trim("FilmKey"), ''), upper(trim("Manufacturer")) || '|' || upper(trim("FilmName"))),
    coalesce(nullif(trim("CoreType"), ''), ''),
    nullif(trim("CoreWeightLbs"), '')::numeric(12, 4),
    nullif(trim("LfWeightLbsPerFt"), '')::numeric(12, 6),
    nullif(trim("PurchaseCost"), '')::numeric(12, 2),
    coalesce(trim("Notes"), ''),
    import.to_bool("HasEverBeenCheckedOut"),
    coalesce(trim("LastCheckoutJob"), ''),
    nullif(trim("LastCheckoutDate"), '')::date,
    nullif(trim("ZeroedDate"), '')::date,
    coalesce(trim("ZeroedReason"), ''),
    coalesce(trim("ZeroedBy"), '')
  from import.boxes_raw
  where coalesce(trim("BoxID"), '') <> '';

  insert into app.jobs (
    id,
    org_id,
    job_number,
    warehouse,
    sections,
    due_date,
    lifecycle_status,
    notes,
    created_at,
    created_by,
    updated_at,
    updated_by
  )
  select
    gen_random_uuid(),
    target_org_id,
    trim("JobNumber"),
    coalesce(nullif(upper(trim("Warehouse")), ''), 'IL')::app.warehouse,
    nullif(trim("Sections"), ''),
    nullif(trim("DueDate"), '')::date,
    case when upper(trim(coalesce("LifecycleStatus", ''))) = 'CANCELLED' then 'CANCELLED' else 'ACTIVE' end::app.job_lifecycle_status,
    coalesce(trim("Notes"), ''),
    coalesce(nullif(trim("CreatedAt"), '')::timestamptz, now()),
    coalesce(trim("CreatedBy"), ''),
    coalesce(nullif(trim("UpdatedAt"), '')::timestamptz, now()),
    coalesce(trim("UpdatedBy"), '')
  from import.jobs_raw
  where coalesce(trim("JobNumber"), '') <> '';

  insert into app.job_requirements (
    id,
    org_id,
    job_id,
    manufacturer,
    film_name,
    width_in,
    required_feet,
    notes,
    created_at,
    created_by,
    updated_at,
    updated_by
  )
  select
    gen_random_uuid(),
    target_org_id,
    j.id,
    trim(r."Manufacturer"),
    trim(r."FilmName"),
    nullif(trim(r."WidthIn"), '')::numeric(10, 4),
    nullif(trim(r."RequiredFeet"), '')::integer,
    coalesce(trim(r."Notes"), ''),
    coalesce(nullif(trim(r."CreatedAt"), '')::timestamptz, now()),
    coalesce(trim(r."CreatedBy"), ''),
    coalesce(nullif(trim(r."UpdatedAt"), '')::timestamptz, now()),
    coalesce(trim(r."UpdatedBy"), '')
  from import.job_requirements_raw r
  join app.jobs j
    on j.org_id = target_org_id
   and j.job_number = trim(r."JobNumber")
  where coalesce(trim(r."JobNumber"), '') <> '';

  insert into app.film_orders (
    id,
    org_id,
    film_order_id,
    job_id,
    job_number,
    warehouse,
    manufacturer,
    film_name,
    width_in,
    requested_feet,
    covered_feet,
    ordered_feet,
    remaining_to_order_feet,
    job_date,
    crew_leader,
    status,
    source_box_id,
    resolved_at,
    resolved_by,
    notes,
    created_at,
    created_by
  )
  select
    gen_random_uuid(),
    target_org_id,
    trim(r."FilmOrderID"),
    j.id,
    trim(r."JobNumber"),
    coalesce(nullif(upper(trim(r."Warehouse")), ''), 'IL')::app.warehouse,
    trim(r."Manufacturer"),
    trim(r."FilmName"),
    nullif(trim(r."WidthIn"), '')::numeric(10, 4),
    nullif(trim(r."RequestedFeet"), '')::integer,
    coalesce(nullif(trim(r."CoveredFeet"), '')::integer, 0),
    coalesce(nullif(trim(r."OrderedFeet"), '')::integer, 0),
    coalesce(nullif(trim(r."RemainingToOrderFeet"), '')::integer, 0),
    nullif(trim(r."JobDate"), '')::date,
    coalesce(trim(r."CrewLeader"), ''),
    case
      when upper(trim(coalesce(r."Status", ''))) = 'FILM_ON_THE_WAY' then 'FILM_ON_THE_WAY'
      when upper(trim(coalesce(r."Status", ''))) = 'FULFILLED' then 'FULFILLED'
      when upper(trim(coalesce(r."Status", ''))) = 'CANCELLED' then 'CANCELLED'
      else 'FILM_ORDER'
    end::app.film_order_status,
    coalesce(trim(r."SourceBoxID"), ''),
    nullif(trim(r."ResolvedAt"), '')::timestamptz,
    coalesce(trim(r."ResolvedBy"), ''),
    coalesce(trim(r."Notes"), ''),
    coalesce(nullif(trim(r."CreatedAt"), '')::timestamptz, now()),
    coalesce(trim(r."CreatedBy"), '')
  from import.film_orders_raw r
  left join app.jobs j
    on j.org_id = target_org_id
   and j.job_number = trim(r."JobNumber")
  where coalesce(trim(r."FilmOrderID"), '') <> '';

  insert into app.film_order_box_links (
    id,
    org_id,
    link_id,
    film_order_id,
    box_id,
    ordered_feet,
    auto_allocated_feet,
    created_at,
    created_by
  )
  select
    gen_random_uuid(),
    target_org_id,
    trim("LinkID"),
    trim("FilmOrderID"),
    trim("BoxID"),
    coalesce(nullif(trim("OrderedFeet"), '')::integer, 0),
    coalesce(nullif(trim("AutoAllocatedFeet"), '')::integer, 0),
    coalesce(nullif(trim("CreatedAt"), '')::timestamptz, now()),
    coalesce(trim("CreatedBy"), '')
  from import.film_order_box_links_raw
  where coalesce(trim("LinkID"), '') <> '';

  insert into app.allocations (
    id,
    org_id,
    allocation_id,
    box_id,
    job_id,
    job_number,
    warehouse,
    job_date,
    allocated_feet,
    status,
    created_at,
    created_by,
    resolved_at,
    resolved_by,
    notes,
    crew_leader,
    film_order_id
  )
  select
    gen_random_uuid(),
    target_org_id,
    trim(r."AllocationID"),
    trim(r."BoxID"),
    j.id,
    trim(r."JobNumber"),
    coalesce(nullif(upper(trim(r."Warehouse")), ''), 'IL')::app.warehouse,
    nullif(trim(r."JobDate"), '')::date,
    nullif(trim(r."AllocatedFeet"), '')::integer,
    case
      when upper(trim(coalesce(r."Status", ''))) = 'FULFILLED' then 'FULFILLED'
      when upper(trim(coalesce(r."Status", ''))) = 'CANCELLED' then 'CANCELLED'
      else 'ACTIVE'
    end::app.allocation_status,
    coalesce(nullif(trim(r."CreatedAt"), '')::timestamptz, now()),
    coalesce(trim(r."CreatedBy"), ''),
    nullif(trim(r."ResolvedAt"), '')::timestamptz,
    coalesce(trim(r."ResolvedBy"), ''),
    coalesce(trim(r."Notes"), ''),
    coalesce(trim(r."CrewLeader"), ''),
    coalesce(trim(r."FilmOrderID"), '')
  from import.allocations_raw r
  left join app.jobs j
    on j.org_id = target_org_id
   and j.job_number = trim(r."JobNumber")
  where coalesce(trim(r."AllocationID"), '') <> '';

  insert into app.audit_log (
    id,
    org_id,
    log_id,
    action,
    box_id,
    before_state,
    after_state,
    actor,
    notes,
    created_at
  )
  select
    gen_random_uuid(),
    target_org_id,
    trim("LogID"),
    trim("Action"),
    trim("BoxID"),
    case
      when lower(trim(coalesce("Before", ''))) in ('', 'null') then null
      else trim("Before")::jsonb
    end,
    case
      when lower(trim(coalesce("After", ''))) in ('', 'null') then null
      else trim("After")::jsonb
    end,
    coalesce(trim("User"), ''),
    coalesce(trim("Notes"), ''),
    coalesce(nullif(trim("Date"), '')::timestamptz, now())
  from import.audit_log_raw
  where coalesce(trim("LogID"), '') <> '';

  insert into app.roll_weight_log (
    id,
    org_id,
    log_id,
    box_id,
    warehouse,
    manufacturer,
    film_name,
    width_in,
    job_number,
    checked_out_at,
    checked_out_by,
    checked_out_weight_lbs,
    checked_in_at,
    checked_in_by,
    checked_in_weight_lbs,
    weight_delta_lbs,
    feet_before,
    feet_after,
    notes
  )
  select
    gen_random_uuid(),
    target_org_id,
    trim("LogID"),
    trim("BoxID"),
    coalesce(nullif(upper(trim("Warehouse")), ''), 'IL')::app.warehouse,
    trim("Manufacturer"),
    trim("FilmName"),
    nullif(trim("WidthIn"), '')::numeric(10, 4),
    coalesce(trim("JobNumber"), ''),
    nullif(trim("CheckedOutAt"), '')::timestamptz,
    coalesce(trim("CheckedOutBy"), ''),
    nullif(trim("CheckedOutWeightLbs"), '')::numeric(12, 2),
    nullif(trim("CheckedInAt"), '')::timestamptz,
    coalesce(trim("CheckedInBy"), ''),
    nullif(trim("CheckedInWeightLbs"), '')::numeric(12, 2),
    nullif(trim("WeightDeltaLbs"), '')::numeric(12, 2),
    coalesce(nullif(trim("FeetBefore"), '')::integer, 0),
    coalesce(nullif(trim("FeetAfter"), '')::integer, 0),
    coalesce(trim("Notes"), '')
  from import.roll_weight_log_raw
  where coalesce(trim("LogID"), '') <> '';
end;
$$;
