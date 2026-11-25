import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.86.0';
import {
  fault, isObject, jsonResponse, readJsonBody, safeFaultResponse,
  sanitizeReports, secureRandomBase64Url, sha256Hex, validateAppVersion, validateConfig, validateName,
} from '../_shared/controller.ts';

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('origin');
  let allowOrigin = '*';
  if (origin && origin !== 'null') {
    try {
      const parsed = new URL(origin);
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin === origin) allowOrigin = origin;
    } catch { /* Invalid Origin is not reflected. */ }
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
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
  if (error?.code === '22023') fault(400, 'invalid_request');
  fault(503, 'unavailable');
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
  return jsonResponse({ ok: true, device_id: data.device_id, device_token: token, revision: Number(data.revision), config }, 200);
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
  return jsonResponse({ ok: true, revision: Number(data.revision), config }, 200);
}

async function handleAction(request: Request, service: SupabaseClient): Promise<Response> {
  const body = await readJsonBody(request, 262_144);
  if (!isObject(body) || typeof body.action !== 'string') fault(400, 'invalid_request');
  if (body.action === 'pair') return await handlePair(service, body);
  if (body.action === 'sync') return await handleSync(request, service, body);
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
