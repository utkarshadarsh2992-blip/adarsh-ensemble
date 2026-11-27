-- Preserve the untouched Cloudflare slot field when the owner rotates only its API token
-- or updates only its Account ID. This merge happens inside a security-definer Vault RPC.
create or replace function public.controller_credentials_write(
  p_scope text, p_provider text, p_slot integer, p_payload text,
  p_key_set boolean, p_account_id_set boolean, p_actor_id uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare v_existing uuid; v_secret_id uuid; v_generation uuid := gen_random_uuid(); v_revision bigint; v_name text;
  v_payload jsonb; v_old_payload jsonb; v_key_set boolean := p_key_set; v_account_set boolean := p_account_id_set;
begin
  if p_scope not in ('app','news','setup') or p_provider is null or p_slot not between 1 and 3
    or p_payload is null or char_length(p_payload) > 32768 or p_actor_id is null then
    raise exception using errcode='22023', message='invalid credential';
  end if;
  begin v_payload := p_payload::jsonb; exception when others then raise exception using errcode='22023', message='invalid credential'; end;
  if jsonb_typeof(v_payload) <> 'object' then raise exception using errcode='22023', message='invalid credential'; end if;
  if not (
    (p_scope='app' and ((p_provider in ('groq','openrouter','gemini','nvidia','cloudflare') and p_slot between 1 and 3) or (p_provider='tavily' and p_slot=1))) or
    (p_scope='news' and p_provider in ('groq','tavily') and p_slot between 1 and 2) or
    (p_scope='setup' and p_provider in ('news','firebase') and p_slot=1)
  ) then raise exception using errcode='22023', message='invalid credential'; end if;
  if p_scope <> 'app' and p_account_id_set then raise exception using errcode='22023', message='invalid credential'; end if;
  if p_key_set and not (v_payload ? 'key' or p_scope='setup') then raise exception using errcode='22023', message='invalid credential'; end if;

  perform 1 from public.controller_credential_state where id=1 for update;
  select s.secret_id,d.decrypted_secret::jsonb into v_existing,v_old_payload
    from public.controller_credential_slots s left join vault.decrypted_secrets d on d.id=s.secret_id
    where s.scope=p_scope and s.provider=p_provider and s.slot=p_slot for update of s;
  if p_scope='app' and p_provider='cloudflare' then
    v_old_payload := coalesce(v_old_payload,'{}'::jsonb);
    v_payload := v_old_payload || v_payload;
    v_key_set := jsonb_typeof(v_payload->'key')='string' and length(v_payload->>'key')>0;
    v_account_set := jsonb_typeof(v_payload->'account_id')='string' and length(v_payload->>'account_id')>0;
  end if;
  v_name := 'adarsh-controller-' || p_scope || '-' || p_provider || '-' || p_slot::text;
  if v_existing is null then
    v_secret_id := vault.create_secret(v_payload::text, v_name, 'ADARSH Controller managed credential', null::uuid);
  else
    v_secret_id := v_existing;
    perform vault.update_secret(v_secret_id, v_payload::text, v_name, 'ADARSH Controller managed credential', null::uuid);
  end if;
  insert into public.controller_credential_slots(scope,provider,slot,secret_id,key_set,account_id_set,generation,updated_at)
    values(p_scope,p_provider,p_slot,v_secret_id,v_key_set,v_account_set,v_generation,now())
  on conflict(scope,provider,slot) do update set secret_id=excluded.secret_id,key_set=excluded.key_set,
    account_id_set=excluded.account_id_set,generation=excluded.generation,updated_at=excluded.updated_at;
  update public.controller_credential_state set credential_revision=credential_revision+1,updated_at=now(),updated_by=p_actor_id where id=1
    returning credential_revision into v_revision;
  insert into public.controller_credential_events(actor_id,event,scope,provider,slot,generation)
    values(p_actor_id,'set',p_scope,p_provider,p_slot,v_generation);
  return jsonb_build_object('ok',true,'revision',v_revision,'generation',v_generation,'key_set',v_key_set,'account_id_set',v_account_set);
end;
$$;

create or replace function public.controller_credentials_for_device(p_device_token_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare v_values jsonb := '{}'::jsonb; v_managed jsonb := '[]'::jsonb; v_setup jsonb := '{}'::jsonb;
  v_setup_managed jsonb := '[]'::jsonb; v_row record; v_payload jsonb; v_base text; v_suffix text;
  v_revision bigint; v_device_settings jsonb;
begin
  if p_device_token_hash !~ '^[0-9a-f]{64}$' or not exists(
    select 1 from public.controller_devices where token_hash=p_device_token_hash and revoked_at is null
  ) then raise exception using errcode='28000', message='invalid device'; end if;
  for v_row in select s.scope,s.provider,s.slot,s.secret_id,s.key_set,s.account_id_set,d.decrypted_secret
    from public.controller_credential_slots s left join vault.decrypted_secrets d on d.id=s.secret_id
    where s.scope in ('app','setup') order by s.scope,s.provider,s.slot loop
    if v_row.scope='setup' then
      v_setup_managed := v_setup_managed || jsonb_build_array(v_row.provider);
      if v_row.key_set and v_row.decrypted_secret is not null then
        v_setup := jsonb_set(v_setup,array[v_row.provider],v_row.decrypted_secret::jsonb,true);
      end if;
    else
      v_suffix := case when v_row.slot=1 then '' else '_'||v_row.slot::text end;
      v_base := case v_row.provider
        when 'groq' then 'GROQ_API_KEY' when 'openrouter' then 'OPENROUTER_API_KEY'
        when 'gemini' then 'GEMINI_API_KEY' when 'nvidia' then 'NVIDIA_API_KEY'
        when 'cloudflare' then 'CLOUDFLARE_API_TOKEN' when 'tavily' then 'TAVILY_API_KEY' else null end;
      if v_base is not null then
        v_managed := v_managed || jsonb_build_array(v_base||v_suffix);
        if v_row.key_set and v_row.decrypted_secret is not null then
          v_payload := v_row.decrypted_secret::jsonb;
          if jsonb_typeof(v_payload->'key')='string' and length(v_payload->>'key')>0 then
            v_values := jsonb_set(v_values,array[v_base||v_suffix],v_payload->'key',true);
          end if;
        end if;
        if v_row.provider='cloudflare' then
          v_managed := v_managed || jsonb_build_array('CLOUDFLARE_ACCOUNT_ID'||v_suffix);
          if v_row.account_id_set and v_row.decrypted_secret is not null then
            v_payload := coalesce(v_payload,v_row.decrypted_secret::jsonb);
            if jsonb_typeof(v_payload->'account_id')='string' and length(v_payload->>'account_id')>0 then
              v_values := jsonb_set(v_values,array['CLOUDFLARE_ACCOUNT_ID'||v_suffix],v_payload->'account_id',true);
            end if;
          end if;
        end if;
      end if;
    end if;
  end loop;
  select credential_revision,device_settings into v_revision,v_device_settings from public.controller_credential_state where id=1;
  return jsonb_build_object('credentials',jsonb_build_object('revision',v_revision,'values',v_values,'managed',v_managed),
    'device_settings',v_device_settings,'setup',v_setup,'setup_managed',v_setup_managed);
end;
$$;

revoke all on function public.controller_credentials_write(text,text,integer,text,boolean,boolean,uuid) from public, anon, authenticated, service_role;
grant execute on function public.controller_credentials_write(text,text,integer,text,boolean,boolean,uuid) to service_role;
revoke all on function public.controller_credentials_for_device(text) from public, anon, authenticated, service_role;
grant execute on function public.controller_credentials_for_device(text) to service_role;
