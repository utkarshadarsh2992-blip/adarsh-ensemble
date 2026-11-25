-- Separate sent/fetched revision from the runtime-validated applied acknowledgement.
-- Controller-only additive update; no News objects or existing data are deleted.
alter table public.controller_devices add column if not exists applied_revision bigint references public.controller_config_revisions(revision);

create or replace function public.controller_sync_device(
  p_device_id uuid, p_device_token_hash text, p_client_revision bigint, p_app_version text, p_reports jsonb
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_device_id uuid; v_revision bigint; v_config jsonb; v_report jsonb; v_day date; v_now_utc date;
begin
  if p_device_token_hash !~ '^[0-9a-f]{64}$' or p_client_revision < 0
    or p_app_version is null or char_length(p_app_version) > 80
    or jsonb_typeof(p_reports) <> 'array' or jsonb_array_length(p_reports) > 14 then
    raise exception using errcode = '22023', message = 'invalid sync';
  end if;
  select id into v_device_id from public.controller_devices
    where id = p_device_id and token_hash = p_device_token_hash and revoked_at is null
    for update;
  if not found then raise exception using errcode = '28000', message = 'invalid device'; end if;
  v_now_utc := (now() at time zone 'UTC')::date;
  for v_report in select value from jsonb_array_elements(p_reports) loop
    begin v_day := (v_report ->> 'day_utc')::date;
    exception when others then raise exception using errcode = '22023', message = 'invalid report day'; end;
    if v_day < v_now_utc - 13 or v_day > v_now_utc or jsonb_typeof(v_report) <> 'object' then
      raise exception using errcode = '22023', message = 'invalid report day';
    end if;
    insert into public.controller_usage_snapshots(device_id, day_utc, report, updated_at)
      values(v_device_id, v_day, v_report, now())
    on conflict(device_id, day_utc) do update set
      report = public.controller_merge_report_snapshot(public.controller_usage_snapshots.report, excluded.report),
      updated_at = now();
  end loop;
  select revision, config into v_revision, v_config from public.controller_config_revisions order by revision desc limit 1;
  update public.controller_devices set app_version = p_app_version, last_seen = now(), config_revision = v_revision, applied_revision = nullif(p_client_revision, 0)
    where id = v_device_id;
  return jsonb_build_object('revision', v_revision, 'config', v_config);
end;
$$;
