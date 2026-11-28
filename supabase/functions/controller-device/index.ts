import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.86.0';
import {
  ControllerFault, fault, isObject, jsonResponse, readJsonBody, safeFaultResponse,
  sanitizeReports, secureRandomBase64Url, sha256Hex, validateAppVersion, validateConfig, validateName,
  validateReason,
} from '../_shared/controller.ts';
import { newsAssistantState, newsSettingsSetForDevice } from '../_shared/newsadmin.ts';
import { validateDeviceSettings } from '../_shared/credentials.ts';

function corsHeaders(request: Request): HeadersInit {
  const configured = (Deno.env.get('ALLOWED_ORIGINS') || 'https://adarshctl-pc68aukk.manus.space,http://localhost:5173,http://localhost:4173,capacitor://localhost')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const origin = request.headers.get('origin') || '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
  if (configured.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) fault(503, 'unavailable');
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fault(400, 'invalid_request');
}

function deviceToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) fault(401, 'unauthorized');
  return match[1];
}

function rpcFault(error: { code?: string } | null | undefined): never {
  if (error?.code === '28000') fault(401, 'unauthorized');
  if (error?.code === '40001') fault(409, 'revision_conflict');
  if (error?.code === 'P0001') fault(429, 'rate_limited');
  if (error?.code === '22023') fault(400, 'invalid_request');
  fault(503, 'unavailable');
}

async function credentialBundle(service: SupabaseClient, tokenHash: string): Promise<Record<string, unknown>> {
  const { data, error } = await service.rpc('controller_credentials_for_device', { p_device_token_hash: tokenHash });
  if (error) rpcFault(error);
  if (!isObject(data) || !isObject(data.credentials) || !isObject(data.device_settings) || !isObject(data.setup) || !Array.isArray(data.setup_managed)) fault(503, 'unavailable');
  return data;
}

async function authenticateDevice(request: Request, service: SupabaseClient): Promise<string> {
  const tokenHash = await sha256Hex(deviceToken(request));
  const { data, error } = await service.from('controller_devices').select('id')
    .eq('token_hash', tokenHash).is('revoked_at', null).maybeSingle();
  if (error) fault(503, 'unavailable');
  if (!data || typeof data.id !== 'string') fault(401, 'unauthorized');
  return tokenHash;
}

function cleanDeviceSettings(value: unknown): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some((key) => !['briefingOn', 'briefingTime', 'newsBriefing', 'briefingTelegram'].includes(key))) fault(503, 'unavailable');
  if (typeof value.briefingOn !== 'boolean' || typeof value.newsBriefing !== 'boolean' ||
    typeof value.briefingTelegram !== 'boolean' || typeof value.briefingTime !== 'string' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.briefingTime)) fault(503, 'unavailable');
  return {
    briefingOn: value.briefingOn,
    briefingTime: value.briefingTime,
    newsBriefing: value.newsBriefing,
    briefingTelegram: value.briefingTelegram,
  };
}

async function assistantSettings(service: SupabaseClient, tokenHash: string): Promise<Record<string, unknown>> {
  const { data, error } = await service.rpc('controller_device_assistant_settings', {
    p_device_token_hash: tokenHash,
  });
  if (error) rpcFault(error);
  return cleanDeviceSettings(data);
}

async function currentConfig(service: SupabaseClient): Promise<{ revision: number; config: ReturnType<typeof validateConfig> }> {
  const { data, error } = await service.from('controller_config_revisions').select('revision,config')
    .order('revision', { ascending: false }).limit(1).maybeSingle();
  if (error || !data || !Number.isSafeInteger(Number(data.revision)) || Number(data.revision) < 1) fault(503, 'unavailable');
  let config;
  try { config = validateConfig(data.config); } catch { fault(503, 'unavailable'); }
  return { revision: Number(data.revision), config };
}

async function handlePair(service: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ['action', 'code', 'name']);
  if (typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(body.code)) fault(401, 'unauthorized');
  const name = validateName(body.name);
  const token = secureRandomBase64Url(32); // Exactly 256 cryptographic random bits; sent once, never stored.
  const [codeHash, tokenHash] = await Promise.all([sha256Hex(body.code), sha256Hex(token)]);
  const { data, error } = await service.rpc('controller_consume_pair_code', {
    p_code_hash: codeHash, p_device_token_hash: tokenHash, p_device_name: name,
  });
  if (error) rpcFault(error);
  if (!isObject(data) || typeof data.device_id !== 'string' || !Number.isSafeInteger(Number(data.revision))) fault(503, 'unavailable');
  let config;
  try { config = validateConfig(data.config); } catch { fault(503, 'unavailable'); }
  const bundle = await credentialBundle(service, tokenHash);
  return jsonResponse({ ok: true, device_id: data.device_id, device_token: token, revision: Number(data.revision), config,
    credentials: bundle.credentials, device_settings: bundle.device_settings, setup: bundle.setup, setup_managed: bundle.setup_managed }, 200);
}

async function handleSync(request: Request, service: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ['action', 'config_revision', 'app_version', 'reports']);
  if (typeof body.config_revision !== 'number' || !Number.isSafeInteger(body.config_revision) || body.config_revision < 0) fault(400, 'invalid_request');
  const appVersion = validateAppVersion(body.app_version);
  const reports = sanitizeReports(body.reports);
  const token = deviceToken(request);
  const tokenHash = await sha256Hex(token);
  const { data: device, error: deviceError } = await service.from('controller_devices').select('id')
    .eq('token_hash', tokenHash).is('revoked_at', null).maybeSingle();
  if (deviceError) fault(503, 'unavailable');
  if (!device) fault(401, 'unauthorized');

  const { data, error } = await service.rpc('controller_sync_device', {
    p_device_id: device.id,
    p_device_token_hash: tokenHash,
    p_client_revision: body.config_revision,
    p_app_version: appVersion,
    p_reports: reports,
  });
  if (error) rpcFault(error);
  if (!isObject(data) || !Number.isSafeInteger(Number(data.revision))) fault(503, 'unavailable');
  let config;
  try { config = validateConfig(data.config); } catch { fault(503, 'unavailable'); }
  const bundle = await credentialBundle(service, tokenHash);
  return jsonResponse({ ok: true, revision: Number(data.revision), config,
    credentials: bundle.credentials, device_settings: bundle.device_settings, setup: bundle.setup, setup_managed: bundle.setup_managed }, 200);
}

async function handleAssistantState(request: Request, service: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ['action']);
  const tokenHash = await authenticateDevice(request, service);
  const [current, deviceSettings, news] = await Promise.all([
    currentConfig(service), assistantSettings(service, tokenHash), newsAssistantState(service),
  ]);
  return jsonResponse({ ok: true, revision: current.revision, config: current.config, device_settings: deviceSettings, news }, 200);
}

async function handleAssistantUpdate(request: Request, service: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ['action', 'kind', 'values', 'expected_revision', 'reason']);
  if (typeof body.kind !== 'string' || !['config', 'news_settings', 'briefing_settings'].includes(body.kind)) fault(400, 'invalid_request');
  const reason = validateReason(body.reason);
  if (body.expected_revision !== undefined && (typeof body.expected_revision !== 'number' || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 1)) fault(400, 'invalid_request');
  const tokenHash = await authenticateDevice(request, service);

  if (body.kind === 'config') {
    if (body.expected_revision === undefined || !isObject(body.values)) fault(400, 'invalid_request');
    exactKeys(body.values, ['models', 'routes']);
    if (!Object.prototype.hasOwnProperty.call(body.values, 'models') || !Object.prototype.hasOwnProperty.call(body.values, 'routes')) fault(400, 'invalid_request');
    const expected = body.expected_revision as number;
    const current = await currentConfig(service);
    if (current.revision !== expected) fault(409, 'revision_conflict');
    let config;
    try {
      // Keep all provider, quality, limit, and issued fields owned by the server.
      config = validateConfig({ ...current.config, models: body.values.models, routes: body.values.routes });
    } catch (error) {
      if (error instanceof ControllerFault) throw error;
      fault(400, 'invalid_config');
    }
    const { data, error } = await service.rpc('controller_device_save_config', {
      p_device_token_hash: tokenHash, p_expected_revision: expected, p_config: config, p_reason: reason,
    });
    if (error) rpcFault(error);
    if (!Number.isSafeInteger(Number(data))) fault(503, 'unavailable');
    return jsonResponse({ ok: true, revision: Number(data) }, 200);
  }

  if (!isObject(body.values)) fault(400, 'invalid_request');
  if (body.kind === 'news_settings') {
    return jsonResponse(await newsSettingsSetForDevice(service, tokenHash, body.values, reason), 200);
  }

  const settings = validateDeviceSettings({ action: 'device_settings_set', settings: body.values });
  const { data, error } = await service.rpc('controller_device_briefing_settings_update', {
    p_device_token_hash: tokenHash, p_device_settings: settings, p_reason: reason,
  });
  if (error) rpcFault(error);
  if (!isObject(data) || !Number.isSafeInteger(Number(data.revision))) fault(503, 'unavailable');
  return jsonResponse({ ok: true, revision: Number(data.revision), device_settings: cleanDeviceSettings(data.device_settings) }, 200);
}

async function handleAction(request: Request, service: SupabaseClient): Promise<Response> {
  const body = await readJsonBody(request, 262_144);
  if (!isObject(body) || typeof body.action !== 'string') fault(400, 'invalid_request');
  if (body.action === 'pair') return await handlePair(service, body);
  if (body.action === 'sync') return await handleSync(request, service, body);
  if (body.action === 'assistant_state') return await handleAssistantState(request, service, body);
  if (body.action === 'assistant_update') return await handleAssistantUpdate(request, service, body);
  fault(400, 'invalid_request');
}

export async function handleControllerDevice(request: Request): Promise<Response> {
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
    const response = await handleAction(request, serviceClient());
    for (const [key, value] of new Headers(cors)) response.headers.set(key, value);
    return response;
  } catch (error) {
    return safeFaultResponse(error, cors);
  }
}

if (import.meta.main) Deno.serve(handleControllerDevice);
