-- IL boxes merge QA spot-check (safe/read-only)
-- Replace the UUID as needed.
-- Current org used in migration: ecf4f1c5-f153-4072-b814-18a41c52fcdc

-- 1) Org total boxes
select count(*) as boxes_total
from app.boxes
where org_id = 'ecf4f1c5-f153-4072-b814-18a41c52fcdc'::uuid;

-- 2) Duplicate box_id guard
select box_id, count(*) as duplicates
from app.boxes
where org_id = 'ecf4f1c5-f153-4072-b814-18a41c52fcdc'::uuid
group by box_id
having count(*) > 1
order by duplicates desc, box_id
limit 50;

-- 3) Required/numeric integrity checks
select count(*) as invalid_required_or_numeric
from app.boxes
where org_id = 'ecf4f1c5-f153-4072-b814-18a41c52fcdc'::uuid
  and (
    trim(box_id) = ''
    or trim(manufacturer) = ''
    or trim(film_name) = ''
    or width_in <= 0
    or initial_feet < 0
    or feet_available < 0
    or feet_available > initial_feet
    or order_date is null
  );

-- 4) Warehouse routing sanity (prefix-derived warehouse must match stored warehouse)
select count(*) as warehouse_routing_mismatches
from app.boxes b
where b.org_id = 'ecf4f1c5-f153-4072-b814-18a41c52fcdc'::uuid
  and app_api.resolve_warehouse_from_box_id('ecf4f1c5-f153-4072-b814-18a41c52fcdc'::uuid, b.box_id) <> b.warehouse;

-- 5) Status distribution
select status, count(*) as row_count
from app.boxes
where org_id = 'ecf4f1c5-f153-4072-b814-18a41c52fcdc'::uuid
group by status
order by row_count desc, status;

-- 6) Warehouse distribution
select warehouse, count(*) as row_count
from app.boxes
where org_id = 'ecf4f1c5-f153-4072-b814-18a41c52fcdc'::uuid
group by warehouse
order by row_count desc, warehouse;
