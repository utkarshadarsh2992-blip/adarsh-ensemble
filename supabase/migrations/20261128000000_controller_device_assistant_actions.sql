-- Paired-device assistant actions are limited to config models/routes, News limits,
-- and the four briefing preferences. All mutations revalidate the active token hash
-- inside the transaction and attribute audit rows to the paired device, never an owner.

alter table public.controller_audit_log
  drop constraint if exists controller_audit_log_event_check;
alter table public.controller_audit_log
  add constraint controller_audit_log_event_check
  check (event in (
    'config_saved','config_rollback','pair_code_created','device_paired','device_revoked',
    'news_settings_saved','briefing_settings_saved'
  ));

create or replace function public.controller_device_assistant_settings(p_device_token_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_device uuid;
  v_settings jsonb;
  v_result jsonb;
begin
  if p_device_token_hash is null or p_device_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '28000', message = 'invalid device';
  end if;
  select id into v_device from public.controller_devices
    where token_hash = p_device_token_hash and revoked_at is null for update;
  if v_device is null then raise exception using errcode = '28000', message = 'invalid device'; end if;
  select device_settings into v_settings from public.controller_credential_state where id = 1;
  if v_settings is null then raise exception using errcode = '55000', message = 'controller unavailable'; end if;
  v_result := jsonb_build_object(
    'briefingOn', case when jsonb_typeof(v_settings->'briefingOn') = 'boolean' then v_settings->'briefingOn' else 'true'::jsonb end,
    'briefingTime', case when jsonb_typeof(v_settings->'briefingTime') = 'string' and (v_settings->>'briefingTime') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then v_settings->'briefingTime' else '"21:30"'::jsonb end,
    'newsBriefing', case when jsonb_typeof(v_settings->'newsBriefing') = 'boolean' then v_settings->'newsBriefing' else 'true'::jsonb end,
    'briefingTelegram', case when jsonb_typeof(v_settings->'briefingTelegram') = 'boolean' then v_settings->'briefingTelegram' else 'true'::jsonb end
  );
  return v_result;
end;
$$;

create or replace function public.controller_device_save_config(
  p_device_token_hash text, p_expected_revision bigint, p_config jsonb, p_reason text
) returns bigint language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_device uuid;
  v_current bigint;
  v_next bigint;
begin
  if p_device_token_hash is null or p_device_token_hash !~ '^[0-9a-f]{64}$'
    or p_expected_revision is null or p_expected_revision < 1
    or p_config is null or jsonb_typeof(p_config) <> 'object' or p_reason is null or char_length(p_reason) > 300 then
    raise exception using errcode = '22023', message = 'invalid assistant config update';
  end if;
  select id into v_device from public.controller_devices
    where token_hash = p_device_token_hash and revoked_at is null for update;
  if v_device is null then raise exception using errcode = '28000', message = 'invalid device'; end if;
  perform pg_advisory_xact_lock(hashtext('adarsh-controller-config-v1'));
  select coalesce(max(revision), 0) into v_current from public.controller_config_revisions;
  if v_current <> p_expected_revision then
    raise exception using errcode = '40001', message = 'controller revision conflict';
  end if;
  v_next := v_current + 1;
  insert into public.controller_config_revisions(revision, config, actor_id, reason)
    values(v_next, p_config, null, p_reason);
  insert into public.controller_audit_log(event, revision, actor_id, device_id, reason, metadata)
    values('config_saved', v_next, null, v_device, p_reason, jsonb_build_object('source', 'paired_device_assistant'));
  return v_next;
end;
$$;

create or replace function public.controller_device_news_settings_update(
  p_device_token_hash text, p_settings jsonb, p_reason text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_device uuid;
  v_item record;
  v_value numeric;
  v_min numeric;
  v_max numeric;
  v_keys jsonb;
begin
  if p_device_token_hash is null or p_device_token_hash !~ '^[0-9a-f]{64}$'
    or p_settings is null or jsonb_typeof(p_settings) <> 'object' or p_settings = '{}'::jsonb
    or p_reason is null or char_length(p_reason) > 300 then
    raise exception using errcode = '22023', message = 'invalid assistant News settings';
  end if;
  select id into v_device from public.controller_devices
    where token_hash = p_device_token_hash and revoked_at is null for update;
  if v_device is null then raise exception using errcode = '28000', message = 'invalid device'; end if;
  for v_item in select key, value from jsonb_each(p_settings) loop
    case v_item.key
      when 'alerts_per_day' then v_min := 0; v_max := 10;
      when 'alert_min_score' then v_min := 1; v_max := 10;
      when 'list_min_score' then v_min := 1; v_max := 10;
      when 'groq_tokens_cap' then v_min := 1000; v_max := 10000000;
      when 'groq_calls_cap' then v_min := 1; v_max := 100000;
      when 'tavily_day_cap' then v_min := 0; v_max := 1000;
      when 'tavily_month_cap' then v_min := 2; v_max := 100000;
      else raise exception using errcode = '22023', message = 'invalid assistant News setting';
    end case;
    if jsonb_typeof(v_item.value) <> 'number' or (v_item.value #>> '{}') !~ '^[0-9]+$' then
      raise exception using errcode = '22023', message = 'invalid assistant News setting';
    end if;
    v_value := (v_item.value #>> '{}')::numeric;
    if v_value < v_min or v_value > v_max then
      raise exception using errcode = '22023', message = 'invalid assistant News setting';
    end if;
    insert into public.settings(key, value) values(v_item.key, to_jsonb(v_value::integer))
      on conflict(key) do update set value = excluded.value;
  end loop;
  select jsonb_agg(key order by key) into v_keys from jsonb_object_keys(p_settings) as keys(key);
  insert into public.controller_audit_log(event, actor_id, device_id, reason, metadata)
    values('news_settings_saved', null, v_device, p_reason, jsonb_build_object('keys', v_keys));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.controller_device_briefing_settings_update(
  p_device_token_hash text, p_device_settings jsonb, p_reason text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_device uuid;
  v_revision bigint;
  v_all_settings jsonb;
  v_keys jsonb;
begin
  if p_device_token_hash is null or p_device_token_hash !~ '^[0-9a-f]{64}$'
    or p_device_settings is null or jsonb_typeof(p_device_settings) <> 'object' or p_device_settings = '{}'::jsonb
    or p_reason is null or char_length(p_reason) > 300 then
    raise exception using errcode = '22023', message = 'invalid assistant briefing settings';
  end if;
  select id into v_device from public.controller_devices
    where token_hash = p_device_token_hash and revoked_at is null for update;
  if v_device is null then raise exception using errcode = '28000', message = 'invalid device'; end if;
  if exists(select 1 from jsonb_object_keys(p_device_settings) k
    where k not in ('briefingOn','briefingTime','newsBriefing','briefingTelegram')) then
    raise exception using errcode = '22023', message = 'invalid assistant briefing setting';
  end if;
  if exists(select 1 from jsonb_each(p_device_settings) e
    where e.key in ('briefingOn','newsBriefing','briefingTelegram') and jsonb_typeof(e.value) <> 'boolean') then
    raise exception using errcode = '22023', message = 'invalid assistant briefing setting';
  end if;
  if p_device_settings ? 'briefingTime' and (
    jsonb_typeof(p_device_settings->'briefingTime') <> 'string'
    or (p_device_settings->>'briefingTime') !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
  ) then raise exception using errcode = '22023', message = 'invalid assistant briefing setting'; end if;
  perform 1 from public.controller_credential_state where id = 1 for update;
  update public.controller_credential_state set
    device_settings = device_settings || p_device_settings,
    credential_revision = credential_revision + 1,
    updated_at = now(),
    updated_by = null
    where id = 1 returning credential_revision, device_settings into v_revision, v_all_settings;
  if v_revision is null then raise exception using errcode = '55000', message = 'controller unavailable'; end if;
  select jsonb_agg(key order by key) into v_keys from jsonb_object_keys(p_device_settings) as keys(key);
  insert into public.controller_audit_log(event, actor_id, device_id, reason, metadata)
    values('briefing_settings_saved', null, v_device, p_reason, jsonb_build_object('keys', v_keys));
  return jsonb_build_object(
    'ok', true,
    'revision', v_revision,
    'device_settings', jsonb_build_object(
      'briefingOn', case when jsonb_typeof(v_all_settings->'briefingOn') = 'boolean' then v_all_settings->'briefingOn' else 'true'::jsonb end,
      'briefingTime', case when jsonb_typeof(v_all_settings->'briefingTime') = 'string' and (v_all_settings->>'briefingTime') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then v_all_settings->'briefingTime' else '"21:30"'::jsonb end,
      'newsBriefing', case when jsonb_typeof(v_all_settings->'newsBriefing') = 'boolean' then v_all_settings->'newsBriefing' else 'true'::jsonb end,
      'briefingTelegram', case when jsonb_typeof(v_all_settings->'briefingTelegram') = 'boolean' then v_all_settings->'briefingTelegram' else 'true'::jsonb end
    )
  );
end;
$$;

revoke all on function public.controller_device_assistant_settings(text) from public, anon, authenticated, service_role;
revoke all on function public.controller_device_save_config(text,bigint,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.controller_device_news_settings_update(text,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.controller_device_briefing_settings_update(text,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.controller_device_assistant_settings(text) to service_role;
grant execute on function public.controller_device_save_config(text,bigint,jsonb,text) to service_role;
grant execute on function public.controller_device_news_settings_update(text,jsonb,text) to service_role;
grant execute on function public.controller_device_briefing_settings_update(text,jsonb,text) to service_role;
