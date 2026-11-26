-- Controller usage only. Complete generation ledgers explicitly include every retained identity.
-- Omitted identities have been compacted into unattributed counters; retaining them again would double-count.
create or replace function public.controller_merge_report_snapshot(p_old jsonb, p_new jsonb, p_path text default '')
returns jsonb language plpgsql immutable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_result jsonb;
  v_key text;
  v_new_value jsonb;
  v_new_item jsonb;
  v_old_item jsonb;
  v_old_keys jsonb;
  v_merged jsonb;
  v_identity_field text;
  v_identity jsonb;
  v_index integer;
  v_field text;
begin
  if p_old is null then return p_new; end if;
  if p_path = '' and p_old ? 'sampled_at' and
     (not (p_new ? 'sampled_at') or (p_new->>'sampled_at')::numeric < (p_old->>'sampled_at')::numeric) then
    return p_old;
  end if;
  if jsonb_typeof(p_old) = 'object' and jsonb_typeof(p_new) = 'object' then
    v_result := p_old;
    for v_key, v_new_value in select key, value from jsonb_each(p_new) loop
      if p_path = 'providers' and v_key = 'keys' and p_new->'keys_complete' = 'true'::jsonb then
        -- A complete ledger is authoritative about membership. Keep monotonic counters only
        -- for identities still present in it; its unknown row already contains compacted usage.
        select coalesce(jsonb_agg(old_key.value), '[]'::jsonb) into v_old_keys
        from jsonb_array_elements(coalesce(p_old->'keys', '[]'::jsonb)) old_key
        where exists (
          select 1 from jsonb_array_elements(v_new_value) new_key
          where old_key.value->'slot' = new_key.value->'slot'
            and coalesce(old_key.value->>'generation', 'legacy') = coalesce(new_key.value->>'generation', 'legacy')
          limit 1
        );
        v_merged := public.controller_merge_report_snapshot(v_old_keys, v_new_value, 'providers.keys');
        v_result := jsonb_set(v_result, array[v_key], v_merged, true);
      elsif p_old ? v_key then
        v_result := jsonb_set(v_result, array[v_key],
          public.controller_merge_report_snapshot(p_old -> v_key, v_new_value,
            case when p_path = '' then v_key else p_path || '.' || v_key end), true);
      else
        v_result := jsonb_set(v_result, array[v_key], v_new_value, true);
      end if;
    end loop;
    return v_result;
  elsif jsonb_typeof(p_old) = 'number' and jsonb_typeof(p_new) = 'number' then
    v_field := regexp_replace(p_path, '^.*[.]', '');
    if v_field in ('req','tok','answers','ok','shak','galat') or p_path like 'features.%' or p_path like 'days.by.%' then
      return to_jsonb(greatest((p_old #>> '{}')::numeric, (p_new #>> '{}')::numeric));
    end if;
    return p_new;
  elsif jsonb_typeof(p_old) = 'array' and jsonb_typeof(p_new) = 'array' then
    v_identity_field := case p_path
      when 'providers' then 'id'
      when 'providers.keys' then 'slot'
      when 'providers.keys.models' then 'model'
      when 'days' then 'day'
      else null end;
    if v_identity_field is null then return p_new; end if;
    v_result := p_old;
    if p_path = 'providers.keys' and exists (
      select 1 from jsonb_array_elements(p_new) item where item ? 'active' limit 1
    ) then
      select coalesce(jsonb_agg(value || '{"active":false}'::jsonb), '[]'::jsonb)
      into v_result from jsonb_array_elements(p_old);
    end if;
    for v_new_item in select value from jsonb_array_elements(p_new) loop
      v_identity := v_new_item -> v_identity_field;
      v_index := null;
      v_old_item := null;
      if v_identity is not null then
        select (ordinality - 1)::integer, value into v_index, v_old_item
        from jsonb_array_elements(v_result) with ordinality
        where value -> v_identity_field = v_identity
          and (p_path <> 'providers.keys' or
            coalesce(value->>'generation', 'legacy') = coalesce(v_new_item->>'generation', 'legacy'))
        limit 1;
      end if;
      if v_index is null then
        v_result := v_result || jsonb_build_array(v_new_item);
      else
        v_merged := public.controller_merge_report_snapshot(v_old_item, v_new_item, p_path);
        v_result := jsonb_set(v_result, array[v_index::text], v_merged, false);
      end if;
    end loop;
    return v_result;
  end if;
  return p_new;
end;
$$;
