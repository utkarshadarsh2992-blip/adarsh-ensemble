import {assertEquals} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {resolveSupabaseServiceKey, safeFunctionError} from '../functions/_shared/diagnostics.ts';

Deno.test('legacy service-role key remains preferred when present', () => {
  assertEquals(resolveSupabaseServiceKey('  legacy-key  ', '{"default":"new-key"}'), 'legacy-key');
});

Deno.test('new Supabase secret-key map supplies its default key as fallback', () => {
  assertEquals(resolveSupabaseServiceKey(undefined, '{"default":"  sb_secret_example  ","backup":"unused"}'), 'sb_secret_example');
});

Deno.test('object errors expose safe code and message, not details or secret values', () => {
  assertEquals(
    safeFunctionError({code:'42P01', message:'relation "public.feeds" does not exist', details:'secret=private-value'}),
    '[42P01] relation "public.feeds" does not exist',
  );
  assertEquals(safeFunctionError({message:'APP_SECRET=private-value rejected'}), 'APP_SECRET=[redacted] rejected');
  assertEquals(safeFunctionError({details:'hidden detail'}), 'Unknown object error');
});
