-- Read-only regression fixtures. Execute after the Controller key-generation migrations.
-- All booleans must be true. This does not insert fake device reports or mutate production data.
with fixtures as (
  select '{"sampled_at":1000,"totals":{"req":6,"tok":60},"providers":[{"id":"groq","req":6,"tok":60,"keys":[{"slot":1,"generation":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","active":false,"req":5,"tok":50},{"slot":1,"generation":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","active":true,"req":1,"tok":10}]}]}'::jsonb as old_report,
    '{"sampled_at":2000,"totals":{"req":6,"tok":60},"providers":[{"id":"groq","keys_complete":true,"req":6,"tok":60,"keys":[{"slot":1,"generation":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","active":true,"req":1,"tok":10},{"slot":1,"active":false,"req":5,"tok":50}]}]}'::jsonb as compacted
  limit 1
), merged as (
  select old_report, compacted, public.controller_merge_report_snapshot(old_report, compacted) as report
  from fixtures limit 1
)
select jsonb_array_length(report#>'{providers,0,keys}') = 2 as compacted_membership,
  not exists (select 1 from jsonb_array_elements(report#>'{providers,0,keys}') k where k->>'generation' = repeat('a',32) limit 1) as pruned_id_removed,
  (select sum((k->>'req')::int) from jsonb_array_elements(report#>'{providers,0,keys}') k limit 1) = 6 as no_duplicate_requests,
  (select sum((k->>'tok')::int) from jsonb_array_elements(report#>'{providers,0,keys}') k limit 1) = 60 as no_duplicate_tokens,
  public.controller_merge_report_snapshot(report, compacted) = report as compacted_retry_idempotent,
  public.controller_merge_report_snapshot(report, old_report) = report as stale_preprune_ignored
from merged limit 1;

with old_keys as (
  select jsonb_agg(jsonb_build_object('slot',1,'generation',md5(n::text),'active',false,'req',1,'tok',10)) as keys
  from generate_series(1,80) n limit 1
), fixture as (
  select jsonb_build_object('sampled_at',1000,'providers',jsonb_build_array(jsonb_build_object('id','groq','keys',keys))) as old_report,
    '{"sampled_at":2000,"providers":[{"id":"groq","keys_complete":true,"keys":[{"slot":1,"active":false,"req":80,"tok":800},{"slot":1,"generation":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","active":true,"req":1,"tok":10},{"slot":2,"active":false,"req":0,"tok":0},{"slot":3,"active":false,"req":0,"tok":0}]}]}'::jsonb as bounded
  from old_keys limit 1
), merged as (
  select bounded, public.controller_merge_report_snapshot(old_report,bounded) as report from fixture limit 1
)
select jsonb_array_length(report#>'{providers,0,keys}') = 4 as complete_array_remains_bounded,
  (select sum((k->>'req')::int) from jsonb_array_elements(report#>'{providers,0,keys}') k limit 1) = 81 as bounded_usage_preserved,
  public.controller_merge_report_snapshot(report,bounded) = report as bounded_retry_idempotent
from merged limit 1;
