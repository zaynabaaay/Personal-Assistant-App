import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type {
  AccessTokenVerifier,
  AuthenticatedUser,
} from './authenticated-user';

declare const process: {
  env: Record<string, string | undefined>;
};

type ClaimsClient = Pick<SupabaseClient['auth'], 'getClaims'>;

export class InvalidAccessTokenError extends Error {
  constructor() {
    super('The access token is invalid or expired.');
    this.name = 'InvalidAccessTokenError';
  }
}

export class SupabaseAuthUnavailableError extends Error {
  constructor() {
    super('Supabase authentication is unavailable.');
    this.name = 'SupabaseAuthUnavailableError';
  }
}

export type SupabaseTokenVerifierOptions = {
  claimsClient?: ClaimsClient;
  publishableKey?: string;
  supabaseUrl?: string;
};

function normalizeSupabaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function hasAuthenticatedAudience(audience: unknown) {
  return audience === 'authenticated' ||
    (Array.isArray(audience) && audience.includes('authenticated'));
}

export function createSupabaseAccessTokenVerifier(
  options: SupabaseTokenVerifierOptions = {},
): AccessTokenVerifier {
  const supabaseUrl = normalizeSupabaseUrl(
    options.supabaseUrl ?? process.env.SUPABASE_URL ?? '',
  );
  const publishableKey =
    options.publishableKey ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? '';

  if (!supabaseUrl || !publishableKey) {
    return async () => {
      throw new SupabaseAuthUnavailableError();
    };
  }

  const claimsClient =
    options.claimsClient ??
    createClient(supabaseUrl, publishableKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    }).auth;
  const expectedIssuer = `${supabaseUrl}/auth/v1`;

  return async (accessToken: string): Promise<AuthenticatedUser> => {
    const { data, error } = await claimsClient.getClaims(accessToken);
    const claims = data?.claims;

    if (
      error ||
      !claims ||
      typeof claims.sub !== 'string' ||
      !claims.sub.trim() ||
      claims.iss !== expectedIssuer ||
      !hasAuthenticatedAudience(claims.aud)
    ) {
      throw new InvalidAccessTokenError();
    }

    return { id: claims.sub };
  };
}
