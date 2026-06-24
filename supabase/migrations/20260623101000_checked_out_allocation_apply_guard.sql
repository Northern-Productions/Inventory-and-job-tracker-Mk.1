-- Allow checked-out boxes with unclaimed physical LF through the allocation apply RPC.
-- Physical checkout remains guarded separately; this only permits allocation claims.

do $$
declare
  v_def text;
  v_next text;
begin
  select pg_get_functiondef('public.api_allocations_apply(uuid, text, jsonb)'::regprocedure)
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');

  v_next := replace(
    v_next,
    'if coalesce(v_source.status::text, '''') not in (''IN_STOCK'', ''ORDERED'', ''TRANSFER'') then',
    'if coalesce(v_source.status::text, '''') not in (''IN_STOCK'', ''ORDERED'', ''TRANSFER'', ''CHECKED_OUT'') then'
  );
  v_next := replace(
    v_next,
    'Only in-stock, ordered, or transfer boxes can be allocated.',
    'Only in-stock, checked-out, ordered, or transfer boxes can be allocated.'
  );
  v_next := replace(
    v_next,
    'and coalesce(b.status::text, '''') in (''IN_STOCK'', ''ORDERED'', ''TRANSFER'')',
    'and coalesce(b.status::text, '''') in (''IN_STOCK'', ''ORDERED'', ''TRANSFER'', ''CHECKED_OUT'')'
  );
  v_next := replace(
    v_next,
    'if coalesce(v_candidate.status::text, '''') not in (''IN_STOCK'', ''ORDERED'', ''TRANSFER'') then',
    'if coalesce(v_candidate.status::text, '''') not in (''IN_STOCK'', ''ORDERED'', ''TRANSFER'', ''CHECKED_OUT'') then'
  );

  if position('not in (''IN_STOCK'', ''ORDERED'', ''TRANSFER'', ''CHECKED_OUT'')' in v_next) = 0 then
    raise exception 'api_allocations_apply checked-out source guard patch failed';
  end if;

  if position('in (''IN_STOCK'', ''ORDERED'', ''TRANSFER'', ''CHECKED_OUT'')' in v_next) = 0 then
    raise exception 'api_allocations_apply checked-out candidate guard patch failed';
  end if;

  if position('Only in-stock, checked-out, ordered, or transfer boxes can be allocated.' in v_next) = 0 then
    raise exception 'api_allocations_apply checked-out error message patch failed';
  end if;

  execute v_next;
end
$$;
