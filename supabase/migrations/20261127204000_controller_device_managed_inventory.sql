-- Only explicitly saved/deleted Controller slots are managed. Preserve untouched
-- legacy phone credentials while retaining durable tombstones for owner deletions.
-- News Groq/Tavily remain excluded and are fetched only by the News Edge Functions.
create or replace function public.controller_credentials_for_device(p_device_token_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare
  v_values jsonb := '{}'::jsonb;
  v_managed jsonb := '[]'::jsonb;
  v_setup jsonb := '{}'::jsonb;
  v_setup_managed jsonb := '[]'::jsonb;
  v_row record;
  v_payload jsonb;
  v_base text;
  v_suffix text;
  v_revision bigint;
  v_device_settings jsonb;
begin
  if p_device_token_hash is null or p_device_token_hash !~ '^[0-9a-f]{64}$' or not exists (
    select 1 from public.controller_devices
    where token_hash = p_device_token_hash and revoked_at is null
  ) then
    raise exception using errcode = '28000', message = 'invalid device';
  end if;

  for v_row in
    with inventory(provider, slot) as (
      select p.provider, s.slot
      from unnest(array['groq','openrouter','gemini','nvidia','cloudflare']) p(provider)
      cross join generate_series(1, 3) s(slot)
      union all select 'tavily', 1
    )
    select i.provider, i.slot, c.secret_id, coalesce(c.key_set, false) as key_set,
      coalesce(c.account_id_set, false) as account_id_set, d.decrypted_secret
    from inventory i
    join public.controller_credential_slots c
      on c.scope = 'app' and c.provider = i.provider and c.slot = i.slot
    left join vault.decrypted_secrets d on d.id = c.secret_id
    order by i.provider, i.slot
  loop
    v_suffix := case when v_row.slot = 1 then '' else '_' || v_row.slot::text end;
    v_base := case v_row.provider
      when 'groq' then 'GROQ_API_KEY'
      when 'openrouter' then 'OPENROUTER_API_KEY'
      when 'gemini' then 'GEMINI_API_KEY'
      when 'nvidia' then 'NVIDIA_API_KEY'
      when 'cloudflare' then 'CLOUDFLARE_API_TOKEN'
      when 'tavily' then 'TAVILY_API_KEY'
      else null end;
    if v_base is null then continue; end if;
    v_managed := v_managed || jsonb_build_array(v_base || v_suffix);
    v_payload := null;
    if v_row.key_set and v_row.decrypted_secret is not null then
      v_payload := v_row.decrypted_secret::jsonb;
      if jsonb_typeof(v_payload->'key') = 'string' and length(v_payload->>'key') > 0 then
        v_values := jsonb_set(v_values, array[v_base || v_suffix], v_payload->'key', true);
      end if;
    end if;
    if v_row.provider = 'cloudflare' then
      v_managed := v_managed || jsonb_build_array('CLOUDFLARE_ACCOUNT_ID' || v_suffix);
      if v_row.account_id_set and v_row.decrypted_secret is not null then
        v_payload := coalesce(v_payload, v_row.decrypted_secret::jsonb);
        if jsonb_typeof(v_payload->'account_id') = 'string' and length(v_payload->>'account_id') > 0 then
          v_values := jsonb_set(v_values, array['CLOUDFLARE_ACCOUNT_ID' || v_suffix], v_payload->'account_id', true);
        end if;
      end if;
    end if;
  end loop;

  for v_row in
    select s.provider, s.key_set, d.decrypted_secret
    from (values ('news'::text), ('firebase'::text)) allowed(provider)
    join public.controller_credential_slots s
      on s.scope = 'setup' and s.provider = allowed.provider and s.slot = 1
    left join vault.decrypted_secrets d on d.id = s.secret_id
    order by allowed.provider
  loop
    v_setup_managed := v_setup_managed || jsonb_build_array(v_row.provider);
    if v_row.key_set and v_row.decrypted_secret is not null then
      v_setup := jsonb_set(v_setup, array[v_row.provider], v_row.decrypted_secret::jsonb, true);
    end if;
  end loop;

  select credential_revision, device_settings into v_revision, v_device_settings
  from public.controller_credential_state where id = 1;
  return jsonb_build_object(
    'credentials', jsonb_build_object('revision', v_revision, 'values', v_values, 'managed', v_managed),
    'device_settings', v_device_settings,
    'setup', v_setup,
    'setup_managed', v_setup_managed
  );
end;
$$;

revoke all on function public.controller_credentials_for_device(text) from public, anon, authenticated, service_role;
grant execute on function public.controller_credentials_for_device(text) to service_role;
