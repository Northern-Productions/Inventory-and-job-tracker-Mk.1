-- Box transfer workflow

alter type app.box_status add value if not exists 'TRANSFER';

create unique index if not exists idx_boxes_org_id_id
  on app.boxes (org_id, id);

create table if not exists app.box_transfers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations(id) on delete cascade,
  transfer_id text not null,
  box_record_id uuid not null,
  source_box_id text not null,
  destination_box_id text not null,
  source_warehouse text not null,
  destination_warehouse text not null,
  status text not null default 'PENDING',
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null default '',
  received_at timestamptz,
  received_by text not null default '',
  cancelled_at timestamptz,
  cancelled_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  unique (org_id, transfer_id),
  foreign key (org_id, box_record_id)
    references app.boxes(org_id, id)
    on delete cascade,
  foreign key (org_id, source_warehouse)
    references app.warehouses(org_id, code)
    on delete restrict,
  foreign key (org_id, destination_warehouse)
    references app.warehouses(org_id, code)
    on delete restrict
);

alter table app.box_transfers
  drop constraint if exists box_transfers_value_format;
alter table app.box_transfers
  add constraint box_transfers_value_format check (
    transfer_id = upper(btrim(transfer_id))
    and btrim(transfer_id) <> ''
    and source_box_id = upper(btrim(source_box_id))
    and btrim(source_box_id) <> ''
    and destination_box_id = upper(btrim(destination_box_id))
    and btrim(destination_box_id) <> ''
    and source_box_id <> destination_box_id
    and source_warehouse = upper(btrim(source_warehouse))
    and destination_warehouse = upper(btrim(destination_warehouse))
    and source_warehouse ~ '^[A-Z]{2}[1-9][0-9]{0,6}$'
    and destination_warehouse ~ '^[A-Z]{2}[1-9][0-9]{0,6}$'
    and status in ('PENDING', 'RECEIVED', 'CANCELLED')
  );

create index if not exists idx_box_transfers_org_box_created
  on app.box_transfers (org_id, box_record_id, created_at desc, id desc);

create unique index if not exists idx_box_transfers_one_pending_per_box
  on app.box_transfers (org_id, box_record_id)
  where status = 'PENDING';

create or replace function public.api_acl_boxes_update(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_lookup_box_id text;
  v_existing_status text := '';
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );

  select upper(btrim(b.status))
  into v_existing_status
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id;

  if v_existing_status = 'TRANSFER' then
    perform app_api.raise_http(
      400,
      format(
        'Box %s has a pending transfer and can only be received or have the transfer cancelled.',
        v_lookup_box_id
      )
    );
  end if;

  v_payload := jsonb_set(v_payload, '{boxId}', to_jsonb(v_lookup_box_id), true);
  return public.api_boxes_update(p_org_id, p_actor, v_payload);
end;
$$;

create or replace function public.api_acl_boxes_set_status(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_lookup_box_id text;
  v_existing_status text := '';
begin
  perform app_api.require_effective_feature_access(p_org_id, 'inventory', 'write');
  v_lookup_box_id := app_api.resolve_box_id_alias(
    p_org_id,
    app_api.require_text(v_payload->>'boxId', 'BoxID')
  );

  select upper(btrim(b.status))
  into v_existing_status
  from app.boxes b
  where b.org_id = p_org_id
    and b.box_id = v_lookup_box_id;

  if v_existing_status = 'TRANSFER' then
    perform app_api.raise_http(
      400,
      format(
        'Box %s has a pending transfer and can only be received or have the transfer cancelled.',
        v_lookup_box_id
      )
    );
  end if;

  v_payload := jsonb_set(v_payload, '{boxId}', to_jsonb(v_lookup_box_id), true);
  return public.api_boxes_set_status(p_org_id, p_actor, v_payload);
end;
$$;

create or replace function public.api_acl_audit_undo(
  p_org_id uuid,
  p_actor text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, app, app_api
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_log_id text := app_api.require_text(v_payload->>'logId', 'LogID');
  v_action text := '';
begin
  perform app_api.require_effective_feature_access(p_org_id, 'activity_history', 'write');

  select upper(btrim(a.action))
  into v_action
  from app.audit_log a
  where a.org_id = p_org_id
    and a.log_id = v_log_id;

  if v_action in ('START_TRANSFER', 'RECEIVE_TRANSFER', 'CANCEL_TRANSFER') then
    perform app_api.raise_http(
      400,
      'Transfer history cannot be undone from audit undo. Use the transfer receive or cancel actions instead.'
    );
  end if;

  return public.api_audit_undo(p_org_id, p_actor, v_payload);
end;
$$;
