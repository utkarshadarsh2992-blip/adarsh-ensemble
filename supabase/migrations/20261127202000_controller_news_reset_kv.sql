-- Keep the editable Controller reset schedule available to the isolated News functions
-- through their existing service-only KV adapter. The update is atomic with Controller state.
create or replace function public.controller_credentials_settings_update(
  p_device_settings jsonb, p_reset_time text, p_actor_id uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_settings jsonb; v_time text; v_revision bigint; v_all_settings jsonb;
begin
  if p_actor_id is null or (p_device_settings is not null and jsonb_typeof(p_device_settings)<>'object') then
    raise exception using errcode='22023', message='invalid settings'; end if;
  v_settings := coalesce(p_device_settings,'{}'::jsonb);
  if exists(select 1 from jsonb_object_keys(v_settings) as x(key) where key not in ('briefingOn','briefingTime','newsBriefing','briefingTelegram')) then
    raise exception using errcode='22023', message='invalid settings'; end if;
  if exists(select 1 from jsonb_each(v_settings) e where e.key in ('briefingOn','newsBriefing','briefingTelegram') and jsonb_typeof(e.value)<>'boolean') then
    raise exception using errcode='22023', message='invalid settings'; end if;
  if v_settings ? 'briefingTime' and (jsonb_typeof(v_settings->'briefingTime')<>'string' or (v_settings->>'briefingTime') !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$') then
    raise exception using errcode='22023', message='invalid settings'; end if;
  if p_reset_time is not null and p_reset_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception using errcode='22023', message='invalid reset time'; end if;
  update public.controller_credential_state set
    device_settings=device_settings || v_settings,
    reset_time=coalesce(p_reset_time,reset_time),
    credential_revision=credential_revision+1,updated_at=now(),updated_by=p_actor_id
    where id=1 returning credential_revision,reset_time,device_settings into v_revision,v_time,v_all_settings;
  if p_reset_time is not null then
    insert into public.kv(key,value,updated_at) values('news:key_reset_time',to_jsonb(v_time),now())
      on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at;
  end if;
  insert into public.controller_credential_events(actor_id,event) values(p_actor_id,'settings');
  return jsonb_build_object('ok',true,'revision',v_revision,'reset_time',v_time,'timezone','Asia/Kolkata','device_settings',v_all_settings);
end;
$$;
revoke all on function public.controller_credentials_settings_update(jsonb,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.controller_credentials_settings_update(jsonb,text,uuid) to service_role;
