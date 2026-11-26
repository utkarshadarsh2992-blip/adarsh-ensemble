alter table if exists public.controller_admins add column if not exists email text;
-- Additive, idempotent news race-prevention primitives. Apply only through the
-- migration workflow; this file is intentionally not applied from this worktree.
create table if not exists public.news_quota_usage (
  scope text primary key check (char_length(scope) between 8 and 40),
  used integer not null default 0 check (used >= 0),
  updated_at timestamptz not null default now()
);
create table if not exists public.news_alert_claims (
  news_id uuid not null references public.news_items(id) on delete cascade,
  day_local date not null,
  claimed_at timestamptz not null default now(),
  primary key(news_id, day_local)
);
alter table public.news_quota_usage enable row level security;
alter table public.news_alert_claims enable row level security;
revoke all on table public.news_quota_usage, public.news_alert_claims from public, anon, authenticated;
grant select, insert, update, delete on table public.news_quota_usage, public.news_alert_claims to service_role;

create or replace function public.claim_tavily_quota(p_day text,p_month text,p_credits integer,p_day_cap integer,p_month_cap integer)
returns boolean language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_day integer; v_month integer;
begin
  if p_credits < 1 or p_day !~ '^\d{4}-\d{2}-\d{2}$' or p_month !~ '^\d{4}-\d{2}$' or p_day_cap < 0 or p_month_cap < 0 then return false; end if;
  perform pg_advisory_xact_lock(hashtext('adarsh-news-tavily-v1'));
  insert into public.news_quota_usage(scope,used) values ('day:'||p_day,0),('month:'||p_month,0) on conflict (scope) do nothing;
  select max(used) filter (where scope='day:'||p_day), max(used) filter (where scope='month:'||p_month) into v_day,v_month from public.news_quota_usage;
  if coalesce(v_day,0)+p_credits>p_day_cap or coalesce(v_month,0)+p_credits>p_month_cap then return false; end if;
  update public.news_quota_usage set used=used+p_credits,updated_at=now() where scope in ('day:'||p_day,'month:'||p_month) and used+p_credits<=case when scope='day:'||p_day then p_day_cap else p_month_cap end;
  return true;
end $$;
create or replace function public.claim_news_alert(p_news_id uuid,p_day date)
returns boolean language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  insert into public.news_alert_claims(news_id,day_local) values(p_news_id,p_day) on conflict do nothing;
  return found;
end $$;
create or replace function public.release_news_alert(p_news_id uuid,p_day date)
returns boolean language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  delete from public.news_alert_claims where news_id=p_news_id and day_local=p_day returning true;
$$;
revoke all on function public.claim_tavily_quota(text,text,integer,integer,integer), public.claim_news_alert(uuid,date), public.release_news_alert(uuid,date) from public, anon, authenticated;
grant execute on function public.claim_tavily_quota(text,text,integer,integer,integer), public.claim_news_alert(uuid,date), public.release_news_alert(uuid,date) to service_role;


-- Recreate the existing pair-code RPC with a small per-admin active-code cap
-- and a creation cooldown. The exception remains deliberately generic at the API.
create or replace function public.controller_create_pair_code(
  p_code_hash text, p_name text, p_expires_at timestamptz, p_actor_id uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_id uuid; v_expiry timestamptz; v_count integer;
begin
  if p_code_hash !~ '^[0-9a-f]{64}$' or p_name is null or char_length(p_name) not between 1 and 60
    or p_expires_at <= now() or p_expires_at > now() + interval '10 minutes' then
    raise exception using errcode = '22023', message = 'invalid pair code request';
  end if;
  perform pg_advisory_xact_lock(hashtext('adarsh-controller-pair-'||p_actor_id::text));
  select count(*) into v_count from public.controller_pair_codes where created_by=p_actor_id and consumed_at is null and expires_at > now();
  if v_count >= 3 or exists(select 1 from public.controller_pair_codes where created_by=p_actor_id and created_at > now()-interval '1 minute') then
    raise exception using errcode = 'P0001', message = 'pair code rate limited';
  end if;
  insert into public.controller_pair_codes(code_hash, name, created_by, expires_at)
    values(p_code_hash, p_name, p_actor_id, p_expires_at) returning id, expires_at into v_id, v_expiry;
  insert into public.controller_audit_log(event, actor_id, reason, metadata)
    values('pair_code_created', p_actor_id, 'Pair code created', jsonb_build_object('name', p_name, 'expires_at', v_expiry));
  return jsonb_build_object('id', v_id, 'expires_at', v_expiry);
end $$;
revoke all on function public.controller_create_pair_code(text,text,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.controller_create_pair_code(text,text,timestamptz,uuid) to service_role;
