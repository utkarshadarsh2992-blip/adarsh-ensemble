-- Pattern Finder pre-warm: every 3 h, news-score?patterns=1 regenerates the
-- cross-country pattern cache only if it is older than 6 h (30-min throttle and
-- the Groq budget stop still apply). The phone then always gets a cached answer
-- inside its 10 s read timeout. Safe to re-run.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'news-patterns-3h';
SELECT cron.schedule('news-patterns-3h', '48 */3 * * *', $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/news-score?patterns=1',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
