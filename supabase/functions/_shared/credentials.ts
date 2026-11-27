import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.86.0';
import { fault, isObject } from './controller.ts';

const APP_PROVIDERS = new Set(['groq', 'openrouter', 'gemini', 'nvidia', 'cloudflare']);
const SCOPED_PROVIDERS = new Set(['groq', 'tavily']);
const SETUP_PROVIDERS = new Set(['news', 'firebase']);
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

type Scope = 'app' | 'news' | 'setup';
type Slot = { scope: Scope; provider: string; slot: number };

function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value) || (!allowEmpty && !value.trim())) fault(400, 'invalid_request');
  return value.trim();
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fault(400, 'invalid_request');
  return value;
}

function exact(body: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(body).some((key) => !keys.includes(key))) fault(400, 'invalid_request');
}

export function validateCredentialSlot(body: Record<string, unknown>, setup = false): Slot {
  const scope = body.scope;
  const provider = body.provider;
  const slot = integer(body.slot, 1, 3);
  if (setup) {
    if (scope !== 'setup' || typeof provider !== 'string' || !SETUP_PROVIDERS.has(provider) || slot !== 1) fault(400, 'invalid_request');
    return { scope: 'setup', provider, slot };
  }
  if (scope === 'app') {
    if (typeof provider !== 'string' || !(APP_PROVIDERS.has(provider) || provider === 'tavily') || (provider === 'tavily' && slot !== 1)) fault(400, 'invalid_request');
    return { scope: 'app', provider, slot };
  }
  if (scope === 'news') {
    if (typeof provider !== 'string' || !SCOPED_PROVIDERS.has(provider) || slot > 2) fault(400, 'invalid_request');
    return { scope: 'news', provider, slot };
  }
  fault(400, 'invalid_request');
}

export type CredentialWrite = Slot & { keySet: boolean; accountIdSet: boolean; payload: Record<string, string> };

export function validateCredentialWrite(body: Record<string, unknown>): CredentialWrite {
  exact(body, ['action', 'scope', 'provider', 'slot', 'key', 'account_id']);
  const slot = validateCredentialSlot(body);
  const key = body.key === undefined ? '' : text(body.key, 8192, true);
  const accountId = body.account_id === undefined ? '' : text(body.account_id, 128, true);
  if (slot.provider === 'cloudflare' && slot.scope === 'app') {
    if (!key && !accountId) fault(400, 'invalid_request');
    if (accountId && !/^[a-fA-F0-9]{32}$/.test(accountId)) fault(400, 'invalid_request');
    return { ...slot, keySet: !!key, accountIdSet: !!accountId, payload: { ...(key ? { key } : {}), ...(accountId ? { account_id: accountId } : {}) } };
  }
  if (!key || accountId) fault(400, 'invalid_request');
  return { ...slot, keySet: true, accountIdSet: false, payload: { key } };
}

export function validateCredentialDelete(body: Record<string, unknown>): Slot {
  exact(body, ['action', 'scope', 'provider', 'slot']);
  return validateCredentialSlot(body);
}

function validHttps(raw: unknown): string {
  const value = text(raw, 2048);
  let url: URL;
  try { url = new URL(value); } catch { fault(400, 'invalid_request'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.search) fault(400, 'invalid_request');
  return value;
}

export type SetupWrite = { provider: 'news' | 'firebase'; payload: Record<string, string> };

export function validateSetupWrite(body: Record<string, unknown>): SetupWrite[] {
  exact(body, ['action', 'news', 'firebase']);
  const result: SetupWrite[] = [];
  if (body.news !== undefined) {
    if (!isObject(body.news)) fault(400, 'invalid_request');
    exact(body.news, ['url', 'secret']);
    const url = validHttps(body.news.url);
    const secret = text(body.news.secret, 512);
    if (secret.length < 16) fault(400, 'invalid_request');
    result.push({ provider: 'news', payload: { url, secret } });
  }
  if (body.firebase !== undefined) {
    if (!isObject(body.firebase)) fault(400, 'invalid_request');
    exact(body.firebase, ['apiKey', 'appId', 'projectId', 'senderId']);
    const payload = {
      apiKey: text(body.firebase.apiKey, 512),
      appId: text(body.firebase.appId, 512),
      projectId: text(body.firebase.projectId, 128),
      senderId: text(body.firebase.senderId, 128),
    };
    result.push({ provider: 'firebase', payload });
  }
  if (!result.length) fault(400, 'invalid_request');
  return result;
}

export function validateSetupDelete(body: Record<string, unknown>): 'news' | 'firebase' {
  exact(body, ['action', 'provider']);
  if (typeof body.provider !== 'string' || !SETUP_PROVIDERS.has(body.provider)) fault(400, 'invalid_request');
  return body.provider as 'news' | 'firebase';
}

export function validateDeviceSettings(body: Record<string, unknown>): Record<string, unknown> {
  exact(body, ['action', 'settings']);
  if (!isObject(body.settings)) fault(400, 'invalid_request');
  exact(body.settings, ['briefingOn', 'briefingTime', 'newsBriefing', 'briefingTelegram']);
  const result: Record<string, unknown> = {};
  for (const key of ['briefingOn', 'newsBriefing', 'briefingTelegram']) {
    if (body.settings[key] !== undefined) {
      if (typeof body.settings[key] !== 'boolean') fault(400, 'invalid_request');
      result[key] = body.settings[key];
    }
  }
  if (body.settings.briefingTime !== undefined) {
    const time = text(body.settings.briefingTime, 5);
    if (!TIME.test(time)) fault(400, 'invalid_request');
    result.briefingTime = time;
  }
  if (!Object.keys(result).length) fault(400, 'invalid_request');
  return result;
}

export function validateResetTime(body: Record<string, unknown>): string {
  exact(body, ['action', 'time']);
  const value = text(body.time, 5);
  if (!TIME.test(value)) fault(400, 'invalid_request');
  return value;
}

function rpcData(data: unknown): Record<string, unknown> {
  const value = Array.isArray(data) ? data[0] : data;
  if (!isObject(value)) fault(503, 'unavailable');
  return value;
}

export async function credentialsState(service: SupabaseClient): Promise<Record<string, unknown>> {
  const { data, error } = await service.rpc('controller_credentials_state');
  if (error) fault(503, 'unavailable');
  return rpcData(data);
}

export async function writeCredential(service: SupabaseClient, actorId: string, value: CredentialWrite): Promise<Record<string, unknown>> {
  const { data, error } = await service.rpc('controller_credentials_write', {
    p_scope: value.scope, p_provider: value.provider, p_slot: value.slot,
    p_payload: JSON.stringify(value.payload), p_key_set: value.keySet,
    p_account_id_set: value.accountIdSet, p_actor_id: actorId,
  });
  if (error) fault(error.code === '22023' ? 400 : 503, error.code === '22023' ? 'invalid_request' : 'unavailable');
  return rpcData(data);
}

export async function deleteCredential(service: SupabaseClient, actorId: string, value: Slot): Promise<Record<string, unknown>> {
  const { data, error } = await service.rpc('controller_credentials_delete', {
    p_scope: value.scope, p_provider: value.provider, p_slot: value.slot, p_actor_id: actorId,
  });
  if (error) fault(error.code === '22023' ? 400 : 503, error.code === '22023' ? 'invalid_request' : 'unavailable');
  return rpcData(data);
}

export async function updateManagedSettings(
  service: SupabaseClient, actorId: string, settings: Record<string, unknown> | null, resetTime: string | null,
): Promise<Record<string, unknown>> {
  const { data, error } = await service.rpc('controller_credentials_settings_update', {
    p_device_settings: settings, p_reset_time: resetTime, p_actor_id: actorId,
  });
  if (error) fault(error.code === '22023' ? 400 : 503, error.code === '22023' ? 'invalid_request' : 'unavailable');
  return rpcData(data);
}

export async function writeSetup(service: SupabaseClient, actorId: string, value: SetupWrite): Promise<void> {
  await writeCredential(service, actorId, {
    scope: 'setup', provider: value.provider, slot: 1, keySet: true, accountIdSet: false, payload: value.payload,
  });
}

export async function deleteSetup(service: SupabaseClient, actorId: string, provider: 'news' | 'firebase'): Promise<void> {
  await deleteCredential(service, actorId, { scope: 'setup', provider, slot: 1 });
}
