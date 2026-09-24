import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { authSessionStorage } from './auth-session-storage';

declare const process: {
  env: Record<string, string | undefined>;
};

export class SupabaseConfigurationError extends Error {
  constructor() {
    super('Supabase authentication is not configured.');
    this.name = 'SupabaseConfigurationError';
  }
}

let client: SupabaseClient | null = null;

function getConfiguration() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!url || !publishableKey) {
    throw new SupabaseConfigurationError();
  }

  return { publishableKey, url };
}

export function getSupabaseClient() {
  if (client) {
    return client;
  }

  const { publishableKey, url } = getConfiguration();

  client = createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      persistSession: true,
      ...(authSessionStorage ? { storage: authSessionStorage } : {}),
    },
  });

  return client;
}
