-- Supply fixed non-secret defaults to the PWA while retaining an empty native settings
-- patch until the owner explicitly saves migrated controls. Existing phone preferences
-- therefore remain untouched on first pair/sync.
create or replace function public.controller_credentials_state()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_state public.controller_credential_state%rowtype; v_slots jsonb; v_device_settings jsonb;
begin
  select * into v_state from public.controller_credential_state where id=1;
  with inventory(scope,provider,slot) as (
    select 'app',p.provider,s.slot from unnest(array['groq','openrouter','gemini','nvidia','cloudflare']) p(provider) cross join generate_series(1,3) s(slot)
    union all select 'app','tavily',1
    union all select 'news',p.provider,s.slot from unnest(array['groq','tavily']) p(provider) cross join generate_series(1,2) s(slot)
    union all select 'setup',p.provider,1 from unnest(array['news','firebase']) p(provider)
  )
  select coalesce(jsonb_agg(
    jsonb_build_object('scope',i.scope,'provider',i.provider,'slot',i.slot,'key_set',coalesce(c.key_set,false),
      'generation',c.generation,'updated_at',c.updated_at) ||
      case when i.provider='cloudflare' and i.scope='app' then jsonb_build_object('account_id_set',coalesce(c.account_id_set,false)) else '{}'::jsonb end
    order by i.scope,i.provider,i.slot
  ),'[]'::jsonb) into v_slots
  from inventory i left join public.controller_credential_slots c
    on c.scope=i.scope and c.provider=i.provider and c.slot=i.slot;
  v_device_settings := jsonb_build_object(
    'briefingOn',coalesce((v_state.device_settings->>'briefingOn')::boolean,true),
    'briefingTime',coalesce(v_state.device_settings->>'briefingTime','21:30'),
    'newsBriefing',coalesce((v_state.device_settings->>'newsBriefing')::boolean,true),
    'briefingTelegram',coalesce((v_state.device_settings->>'briefingTelegram')::boolean,true)
  );
  return jsonb_build_object(
    'ok',true,'slots',v_slots,'reset_time',v_state.reset_time,'timezone',v_state.timezone,
    'device_settings',v_device_settings,
    'setup_status',jsonb_build_object(
      'news',exists(select 1 from public.controller_credential_slots where scope='setup' and provider='news' and key_set),
      'firebase',exists(select 1 from public.controller_credential_slots where scope='setup' and provider='firebase' and key_set)
    )
  );
end;
$$;
revoke all on function public.controller_credentials_state() from public, anon, authenticated, service_role;
grant execute on function public.controller_credentials_state() to service_role;
