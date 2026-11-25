-- Repair the News Edge Function database access without changing or deleting rows.
-- RLS remains enabled; anonymous/authenticated clients receive no new privileges.

GRANT SELECT, UPDATE ON TABLE public.feeds TO service_role;
GRANT SELECT, INSERT ON TABLE public.seen_news TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.news_items TO service_role;
GRANT SELECT ON TABLE public.watchlist TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_devices TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.settings TO service_role;
GRANT SELECT, INSERT ON TABLE public.alert_log TO service_role;
GRANT SELECT ON TABLE public.ai_usage TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.kv TO service_role;
GRANT USAGE ON SEQUENCE public.alert_log_id_seq TO service_role;

-- Keep the existing cadence and Vault-backed headers, but override pg_net's
-- 5-second default for every scheduled Edge Function request.
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN (
  'news-ingest-5m',
  'news-score-5m',
  'news-digest-10m',
  'news-clean-daily'
);

SELECT cron.schedule('news-ingest-5m', '*/5 * * * *', $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/news-ingest',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

SELECT cron.schedule('news-score-5m', '2-59/5 * * * *', $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/news-score',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

SELECT cron.schedule('news-digest-10m', '*/10 * * * *', $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/news-digest',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

SELECT cron.schedule('news-clean-daily', '0 3 * * *', $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/news-clean',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
