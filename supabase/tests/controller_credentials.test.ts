import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  validateCredentialDelete, validateCredentialWrite, validateDeviceSettings,
  validateResetTime, validateSetupDelete, validateSetupWrite,
} from '../functions/_shared/credentials.ts';

Deno.test('answer/research Tavily and News Tavily slots stay scope-separated', () => {
  assertEquals(validateCredentialWrite({ action: 'credentials_set', scope: 'app', provider: 'tavily', slot: 1, key: 'unit-placeholder-key' }).scope, 'app');
  assertEquals(validateCredentialWrite({ action: 'credentials_set', scope: 'news', provider: 'tavily', slot: 2, key: 'unit-placeholder-key' }).slot, 2);
  assertThrows(() => validateCredentialWrite({ action: 'credentials_set', scope: 'app', provider: 'tavily', slot: 2, key: 'unit-placeholder-key' }));
  assertThrows(() => validateCredentialWrite({ action: 'credentials_set', scope: 'news', provider: 'tavily', slot: 3, key: 'unit-placeholder-key' }));
  assertEquals(validateCredentialDelete({ action: 'credentials_delete', scope: 'app', provider: 'tavily', slot: 1 }).scope, 'app');
  assertEquals(validateCredentialDelete({ action: 'credentials_delete', scope: 'news', provider: 'tavily', slot: 1 }).scope, 'news');
});

Deno.test('Cloudflare supports an Account-ID-only update but requires a valid account ID', () => {
  const account_id = '0123456789abcdef0123456789abcdef';
  const result = validateCredentialWrite({ action: 'credentials_set', scope: 'app', provider: 'cloudflare', slot: 2, key: '', account_id });
  assertEquals(result.keySet, false);
  assertEquals(result.accountIdSet, true);
  assertEquals(result.payload.account_id, account_id);
  assertThrows(() => validateCredentialWrite({ action: 'credentials_set', scope: 'app', provider: 'cloudflare', slot: 1, key: '', account_id: 'bad' }));
  assertThrows(() => validateCredentialWrite({ action: 'credentials_set', scope: 'app', provider: 'groq', slot: 1, key: '', account_id }));
});

Deno.test('provider keys require a nonempty key and reject wrong scope/provider slots', () => {
  assertEquals(validateCredentialWrite({ action: 'credentials_set', scope: 'news', provider: 'groq', slot: 1, key: 'unit-placeholder-key' }).keySet, true);
  assertThrows(() => validateCredentialWrite({ action: 'credentials_set', scope: 'news', provider: 'groq', slot: 1, key: '' }));
  assertThrows(() => validateCredentialWrite({ action: 'credentials_set', scope: 'app', provider: 'news', slot: 1, key: 'unit-placeholder-key' }));
});

Deno.test('briefing and reset controls accept only explicit boolean flags and HH:MM', () => {
  assertEquals(validateDeviceSettings({ action: 'device_settings_set', settings: { briefingOn: false, briefingTime: '23:55', newsBriefing: true } }),
    { briefingOn: false, briefingTime: '23:55', newsBriefing: true });
  assertThrows(() => validateDeviceSettings({ action: 'device_settings_set', settings: { briefingOn: 'false' } }));
  assertThrows(() => validateDeviceSettings({ action: 'device_settings_set', settings: { briefingTime: '24:00' } }));
  assertEquals(validateResetTime({ action: 'news_key_reset', time: '05:00' }), '05:00');
  assertThrows(() => validateResetTime({ action: 'news_key_reset', time: '5am' }));
});

Deno.test('News/Firebase setup schemas and delete scope are constrained', () => {
  const setup = validateSetupWrite({ action: 'setup_set', news: { url: 'https://news.example/functions/v1/news-api', secret: 'unit-test-secret-16' } });
  assertEquals(setup[0].provider, 'news');
  assertThrows(() => validateSetupWrite({ action: 'setup_set', news: { url: 'http://news.example', secret: 'unit-test-secret-16' } }));
  assertEquals(validateSetupDelete({ action: 'setup_delete', provider: 'firebase' }), 'firebase');
  assertThrows(() => validateSetupDelete({ action: 'setup_delete', provider: 'groq' }));
});
