export function resolveSupabaseServiceKey(legacyValue: string | undefined, secretKeysJson: string | undefined): string {
  const legacy = legacyValue?.trim();
  if (legacy) return legacy;

  if (!secretKeysJson?.trim()) {
    throw new Error('Supabase service key missing: expected SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEYS.default');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(secretKeysJson);
  } catch {
    throw new Error('SUPABASE_SECRET_KEYS is invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SUPABASE_SECRET_KEYS must be a JSON object');
  }

  const key = (parsed as Record<string, unknown>).default;
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('SUPABASE_SECRET_KEYS.default is missing');
  }
  return key.trim();
}

function redact(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:sb_secret|sb_publishable)_[A-Za-z0-9_-]+\b/gi, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/((?:service[_-]?role[_-]?key|(?:app|cron)?[_-]?(?:api[_-]?key|secret)|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function safeFunctionError(error: unknown): string {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const code = typeof record?.code === 'string' ? record.code.trim() : '';
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === 'string'
      ? record.message
      : typeof error === 'string'
        ? error
        : 'Unknown object error';
  const prefix = code ? `[${redact(code)}] ` : '';
  return (redact(`${prefix}${message}`).slice(0, 240) || 'Unknown server error');
}
