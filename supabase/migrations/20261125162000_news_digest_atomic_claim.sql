-- Atomically claim today's News digest before delivering it. This is additive and
-- changes only the existing digest:last_day KV key; News data and schedules stay intact.
create or replace function public.claim_news_digest(p_day date)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_value jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('adarsh-news-digest-daily-claim-v1'));

  select value into v_value
  from public.kv
  where key = 'digest:last_day'
  for update;

  if v_value is not distinct from to_jsonb(p_day::text) then
    return false;
  end if;

  insert into public.kv(key, value, updated_at)
  values ('digest:last_day', to_jsonb(p_day::text), now())
  on conflict (key) do update
    set value = excluded.value,
        updated_at = excluded.updated_at;

  return true;
end;
$$;

revoke all on function public.claim_news_digest(date) from public, anon, authenticated, service_role;
grant execute on function public.claim_news_digest(date) to service_role;
