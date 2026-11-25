-- Requires pg_cron, pg_net, and Vault enabled in the Supabase dashboard.
-- User runs once after this migration (replace placeholders in the SQL editor):
-- select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co','project_url');
-- select vault.create_secret('generate-a-random-32-plus-character-cron-secret','cron_secret');
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Unschedule first so this migration is safe to re-run.
select cron.unschedule(jobid) from cron.job where jobname in
  ('news-ingest-5m','news-score-5m','news-digest-10m','news-clean-daily');

select cron.schedule('news-ingest-5m','*/5 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='project_url') || '/functions/v1/news-ingest',
    headers := jsonb_build_object('content-type','application/json','x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')),
    body := '{}'::jsonb);
$$);
select cron.schedule('news-score-5m','2-59/5 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='project_url') || '/functions/v1/news-score',
    headers := jsonb_build_object('content-type','application/json','x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')),
    body := '{}'::jsonb);
$$);
select cron.schedule('news-digest-10m','*/10 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='project_url') || '/functions/v1/news-digest',
    headers := jsonb_build_object('content-type','application/json','x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')),
    body := '{}'::jsonb);
$$);
select cron.schedule('news-clean-daily','0 3 * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='project_url') || '/functions/v1/news-clean',
    headers := jsonb_build_object('content-type','application/json','x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='cron_secret')),
    body := '{}'::jsonb);
$$);
