-- Restore the caulk reserved-tube release action in the owner-aware stock helper.
-- Stage A only: this keeps the current caulk stock model unchanged.

do $$
declare
  v_def text;
  v_base text;
  v_next text;
begin
  select pg_get_functiondef(
    'app_api.caulk_apply_stock_delta_for_owner(uuid, text, uuid, text, uuid, text, integer, text, text, text, text)'::regprocedure
  )
  into v_def;

  v_next := replace(v_def, E'\r\n', E'\n');
  v_base := v_next;

  if position('''JOB_ALLOCATION_CANCEL_RETURN''' in v_next) = 0 then
    v_next := replace(
      v_next,
      E'''JOB_CHECKIN_UNUSED'', ''BACKFILL_MIGRATE''',
      E'''JOB_CHECKIN_UNUSED'', ''JOB_ALLOCATION_CANCEL_RETURN'', ''BACKFILL_MIGRATE'''
    );

    if v_next = v_base
       or position('''JOB_ALLOCATION_CANCEL_RETURN''' in v_next) = 0
       or position('Unsupported caulk stock action.' in v_next) = 0 then
      raise exception 'caulk_apply_stock_delta_for_owner cancel-return action patch did not match expected snippets';
    end if;

    execute v_next;
  end if;
end;
$$;

do $$
declare
  v_def text;
begin
  select pg_get_functiondef(
    'app_api.caulk_apply_stock_delta_for_owner(uuid, text, uuid, text, uuid, text, integer, text, text, text, text)'::regprocedure
  )
  into v_def;

  if position('''JOB_ALLOCATION_CANCEL_RETURN''' in v_def) = 0 then
    raise exception 'caulk_apply_stock_delta_for_owner still rejects allocation cancel return actions';
  end if;

  if position('Unsupported caulk stock action.' in v_def) = 0 then
    raise exception 'caulk_apply_stock_delta_for_owner no longer rejects unsupported actions';
  end if;

  if position('and s.owner_company_id = v_owner.id' in v_def) = 0
     or position('for update' in lower(v_def)) = 0
     or position('app_api.require_owner_company(p_org_id, p_owner_company_id, false)' in v_def) = 0 then
    raise exception 'caulk_apply_stock_delta_for_owner lost exact owner-row stock mutation guards';
  end if;
end;
$$;
