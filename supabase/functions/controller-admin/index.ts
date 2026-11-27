import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.86.0';
import {
  ControllerFault, fault, isObject, jsonResponse, readJsonBody, safeFaultResponse,
  sanitizeReport, secureRandomBase64Url, sha256Hex, validateConfig, validateName, validateReason,
} from '../_shared/controller.ts';
import { newsSettingsSet, newsState } from '../_shared/newsadmin.ts';
import {
  credentialsState, deleteCredential, deleteSetup, updateManagedSettings, validateCredentialDelete,
  validateCredentialWrite, validateDeviceSettings, validateResetTime, validateSetupDelete,
  validateSetupWrite, writeCredential, writeSetup,
} from '../_shared/credentials.ts';

function corsHeaders(request: Request): HeadersInit {
  const configured = (Deno.env.get('ALLOWED_ORIGINS') || 'https://adarshctl-pc68aukk.manus.space,http://localhost:5173').split(',').map(x=>x.trim()).filter(Boolean);
  const origin = request.headers.get('origin') || '';
  const headers: Record<string,string> = {'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Max-Age':'600','Vary':'Origin'};
  if (configured.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}
function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) fault(503, 'unavailable');
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

function bearer(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9._~-]{20,4096})$/i.exec(header);
  if (!match) fault(401, 'unauthorized');
  return match[1];
}

async function authorizeAdmin(request: Request): Promise<{ id: string; service: SupabaseClient }> {
  const jwt = bearer(request);
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !anonKey) fault(503, 'unavailable');
  const service = serviceClient();
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(jwt);
  if (userError || !userData.user) fault(401, 'unauthorized');
  const { data: allowed, error: allowError } = await service
    .from('controller_admins').select('user_id,email').eq('user_id', userData.user.id).eq('enabled', true).maybeSingle();
  if (allowError) fault(503, 'unavailable');
  if (!allowed || typeof allowed.email !== 'string' || !allowed.email || !userData.user.email || allowed.email.trim().toLowerCase() !== userData.user.email.trim().toLowerCase() || !userData.user.email_confirmed_at) fault(403, 'not_allowed');
  return { id: userData.user.id, service };
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) fault(400, 'invalid_request');
}

function requiredInt(value: unknown, min = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) fault(400, 'invalid_request');
  return value;
}

function cursorOffsets(value: unknown): { devices: number; usage: number; history: number } {
  if (value === undefined) return { devices: 0, usage: 0, history: 0 };
  if (typeof value !== 'string' || value.length > 80) fault(400, 'invalid_request');
  const match = /^v1:(\d{1,7}):(\d{1,7}):(\d{1,7})$/.exec(value);
  if (!match) fault(400, 'invalid_request');
  const offsets = match.slice(1).map(Number);
  if (offsets.some((offset) => !Number.isSafeInteger(offset) || offset > 1_000_000)) fault(400, 'invalid_request');
  return { devices: offsets[0], usage: offsets[1], history: offsets[2] };
}

function nextCursor(devices: number, usage: number, history: number, hasMore: boolean): string | undefined {
  return hasMore ? `v1:${devices}:${usage}:${history}` : undefined;
}

function rpcFault(error: { code?: string } | null | undefined): never {
  if (error?.code === '40001') fault(409, 'revision_conflict');
  if (error?.code === 'P0002') fault(404, 'not_found');
  if (error?.code === 'P0001') fault(429, 'rate_limited');
  if (error?.code === '22023') fault(400, 'invalid_request');
  fault(503, 'unavailable');
}

function utcStartDay(): string {
  const date = new Date(Date.now() - 13 * 86_400_000);
  return date.toISOString().slice(0, 10);
}

async function forwardNewsOperation(operation: unknown): Promise<Response> {
  if (typeof operation !== 'string' || !['telegram_link', 'telegram_test', 'fcm_test', 'digest_now'].includes(operation)) fault(400, 'invalid_request');
  const base = Deno.env.get('SUPABASE_URL')?.trim();
  const secret = Deno.env.get('APP_SECRET')?.trim();
  if (!base || !secret || secret.length < 16) fault(503, 'unavailable');
  let endpoint: URL;
  try { endpoint = new URL('/functions/v1/news-api', base); } catch { fault(503, 'unavailable'); }
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'yepupldfjtikalfzehvl.supabase.co') fault(503, 'unavailable');
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-app-secret': secret, 'Cache-Control': 'no-store' },
      body: JSON.stringify({ action: operation }),
      signal: AbortSignal.timeout(12_000), cache: 'no-store',
    });
  } catch { fault(503, 'unavailable'); }
  const raw = await response.text().catch(() => '');
  if (raw.length > 1_000_000) fault(503, 'unavailable');
  let result: unknown;
  try { result = JSON.parse(raw); } catch { fault(503, 'unavailable'); }
  if (!isObject(result)) fault(503, 'unavailable');
  if (!response.ok) fault(response.status === 429 ? 429 : 503, response.status === 429 ? 'rate_limited' : 'unavailable');
  return jsonResponse(result, 200);
}

async function getState(service: SupabaseClient, cursorValue: unknown): Promise<Response> {
  const offsets = cursorOffsets(cursorValue);
  const [configResult, devicesResult, usageResult, historyResult] = await Promise.all([
    service.from('controller_config_revisions').select('revision,config').order('revision', { ascending: false }).limit(1).maybeSingle(),
    service.from('controller_devices').select('id,name,last_seen,revoked_at,config_revision,applied_revision')
      .order('id', { ascending: true }).range(offsets.devices, offsets.devices + 30),
    service.from('controller_usage_snapshots').select('device_id,day_utc,report,updated_at')
      .gte('day_utc', utcStartDay()).order('day_utc', { ascending: false }).order('device_id', { ascending: true })
      .range(offsets.usage, offsets.usage + 420),
    service.from('controller_config_revisions').select('revision,created_at,actor_id,reason')
      .order('revision', { ascending: false }).range(offsets.history, offsets.history + 30),
  ]);
  if (configResult.error || devicesResult.error || usageResult.error || historyResult.error || !configResult.data) fault(503, 'unavailable');
  let config;
  try { config = validateConfig(configResult.data.config); } catch { fault(503, 'unavailable'); }
  const devices = (devicesResult.data ?? []).slice(0, 30);
  const usageRows = (usageResult.data ?? []).slice(0, 420);
  const history = (historyResult.data ?? []).slice(0, 30);
  const usage = usageRows.map((row) => {
    try { return { device_id: row.device_id, day_utc: row.day_utc, report: sanitizeReportForState(row.report), updated_at: row.updated_at }; }
    catch { fault(503, 'unavailable'); }
  });
  const hasMore = (devicesResult.data?.length ?? 0) > 30 || (usageResult.data?.length ?? 0) > 420 || (historyResult.data?.length ?? 0) > 30;
  const cursor = nextCursor(offsets.devices + devices.length, offsets.usage + usage.length, offsets.history + history.length, hasMore);
  return jsonResponse({
    ok: true,
    revision: Number(configResult.data.revision),
    config,
    devices,
    usage,
    history,
    ...(cursor ? { next_cursor: cursor } : {}),
  }, 200);
}

function sanitizeReportForState(value: unknown): Record<string, unknown> {
  // Imports are kept above the request handler; this validates and strips even if a row was altered outside the API.
  return sanitizeReport(value);
}

async function handleAction(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  if (!isObject(body) || typeof body.action !== 'string') fault(400, 'invalid_request');
  const { id: actorId, service } = await authorizeAdmin(request);

  if (body.action === 'state') {
    exactKeys(body, ['action', 'cursor']);
    return await getState(service, body.cursor);
  }

  if (body.action === 'news_state') {
    exactKeys(body, ['action']);
    return jsonResponse(await newsState(service), 200);
  }
  if (body.action === 'news_settings') {
    exactKeys(body, ['action', 'settings']);
    return jsonResponse(await newsSettingsSet(service, body.settings), 200);
  }
  if (body.action === 'credentials_state') {
    exactKeys(body, ['action']);
    return jsonResponse(await credentialsState(service), 200);
  }
  if (body.action === 'credentials_set') {
    const credential = validateCredentialWrite(body);
    await writeCredential(service, actorId, credential);
    return jsonResponse(await credentialsState(service), 200);
  }
  if (body.action === 'credentials_delete') {
    const credential = validateCredentialDelete(body);
    await deleteCredential(service, actorId, credential);
    return jsonResponse(await credentialsState(service), 200);
  }
  if (body.action === 'device_settings_set') {
    const settings = validateDeviceSettings(body);
    await updateManagedSettings(service, actorId, settings, null);
    return jsonResponse(await credentialsState(service), 200);
  }
  if (body.action === 'news_key_reset') {
    const time = validateResetTime(body);
    await updateManagedSettings(service, actorId, null, time);
    return jsonResponse(await credentialsState(service), 200);
  }
  if (body.action === 'setup_set') {
    const setup = validateSetupWrite(body);
    for (const value of setup) await writeSetup(service, actorId, value);
    return jsonResponse(await credentialsState(service), 200);
  }
  if (body.action === 'setup_delete') {
    const provider = validateSetupDelete(body);
    await deleteSetup(service, actorId, provider);
    return jsonResponse(await credentialsState(service), 200);
  }
  if (body.action === 'news_operation') {
    exactKeys(body, ['action', 'operation']);
    return await forwardNewsOperation(body.operation);
  }
  if (body.action === 'save') {
    exactKeys(body, ['action', 'expected_revision', 'config', 'reason']);
    const expected = requiredInt(body.expected_revision);
    const config = validateConfig(body.config);
    const reason = validateReason(body.reason);
    const { data, error } = await service.rpc('controller_save_config', {
      p_expected_revision: expected, p_config: config, p_actor_id: actorId, p_reason: reason,
    });
    if (error) rpcFault(error);
    return jsonResponse({ ok: true, revision: Number(data) }, 200);
  }

  if (body.action === 'rollback') {
    exactKeys(body, ['action', 'expected_revision', 'target_revision']);
    const expected = requiredInt(body.expected_revision);
    const target = requiredInt(body.target_revision);
    const { data: oldConfig, error: readError } = await service.from('controller_config_revisions')
      .select('config').eq('revision', target).maybeSingle();
    if (readError) fault(503, 'unavailable');
    if (!oldConfig) fault(404, 'not_found');
    try { validateConfig(oldConfig.config); } catch { fault(503, 'unavailable'); }
    const { data, error } = await service.rpc('controller_rollback_config', {
      p_expected_revision: expected, p_target_revision: target, p_actor_id: actorId,
    });
    if (error) rpcFault(error);
    return jsonResponse({ ok: true, revision: Number(data) }, 200);
  }

  if (body.action === 'pair_code') {
    exactKeys(body, ['action', 'name']);
    const name = validateName(body.name);
    const code = secureRandomBase64Url(24);
    const expiresAt = new Date(Date.now() + 8 * 60_000).toISOString();
    const codeHash = await sha256Hex(code);
    const { data, error } = await service.rpc('controller_create_pair_code', {
      p_code_hash: codeHash, p_name: name, p_expires_at: expiresAt, p_actor_id: actorId,
    });
    if (error) rpcFault(error);
    return jsonResponse({ ok: true, code, expires_at: data.expires_at }, 200);
  }

  if (body.action === 'revoke') {
    exactKeys(body, ['action', 'device_id']);
    if (typeof body.device_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.device_id)) fault(400, 'invalid_request');
    const { error } = await service.rpc('controller_revoke_device', { p_device_id: body.device_id, p_actor_id: actorId });
    if (error) rpcFault(error);
    return jsonResponse({ ok: true }, 200);
  }

  throw new ControllerFault(400, 'invalid_request');
}

export async function handleControllerAdmin(request: Request): Promise<Response> {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') {
    const headers = new Headers(cors);
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    headers.set('Pragma', 'no-cache');
    headers.set('Expires', '0');
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: { code: 'invalid_request', message: 'POST required.' } }, 405, cors);
  try {
    const response = await handleAction(request);
    for (const [key, value] of new Headers(cors)) response.headers.set(key, value);
    return response;
  } catch (error) {
    return safeFaultResponse(error, cors);
  }
}

if (import.meta.main) Deno.serve(handleControllerAdmin);
