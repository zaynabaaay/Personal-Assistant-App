import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthService } from '../src/services/auth/auth-service.ts';
import {
  createSupabaseAccessTokenVerifier,
  InvalidAccessTokenError,
} from '../src/server/auth/supabase-token-verifier.ts';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const SESSION = {
  access_token: 'access-token',
  expires_at: 2_000_000_000,
  expires_in: 3600,
  refresh_token: 'refresh-token',
  token_type: 'bearer',
  user: {
    app_metadata: {},
    aud: 'authenticated',
    created_at: '2026-08-11T00:00:00.000Z',
    email: 'owner@example.com',
    id: USER_ID,
    user_metadata: {},
  },
};

function createFakeAuthClient(initialSession = SESSION) {
  let session = initialSession;
  let listener = () => undefined;
  let signInCredentials = null;
  let signOutCalls = 0;

  return {
    get signInCredentials() {
      return signInCredentials;
    },
    get signOutCalls() {
      return signOutCalls;
    },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: (nextListener) => {
        listener = nextListener;
        return {
          data: { subscription: { unsubscribe: () => undefined } },
        };
      },
      signInWithPassword: async (credentials) => {
        signInCredentials = credentials;
        return { data: { session, user: session?.user }, error: null };
      },
      signOut: async () => {
        signOutCalls += 1;
        session = null;
        listener('SIGNED_OUT', null);
        return { error: null };
      },
      startAutoRefresh: () => undefined,
      stopAutoRefresh: () => undefined,
    },
  };
}

test('email/password sign-in uses the private owner credentials', async () => {
  const fakeClient = createFakeAuthClient();
  const service = new AuthService(() => fakeClient);

  assert.deepEqual(
    await service.signInWithPassword('  owner@example.com ', 'owner-password'),
    {
      accessToken: 'access-token',
      user: { email: 'owner@example.com', id: USER_ID },
    },
  );
  assert.deepEqual(fakeClient.signInCredentials, {
    email: 'owner@example.com',
    password: 'owner-password',
  });
});

test('the auth service restores the persisted session and exposes the user ID', async () => {
  const fakeClient = createFakeAuthClient();
  const service = new AuthService(() => fakeClient);

  assert.deepEqual(await service.getSession(), {
    accessToken: 'access-token',
    user: { email: 'owner@example.com', id: USER_ID },
  });
  assert.deepEqual(await service.getAuthenticatedUser(), {
    email: 'owner@example.com',
    id: USER_ID,
  });
  assert.equal(await service.getAccessToken(), 'access-token');
});

test('sign-out clears the authenticated session', async () => {
  const fakeClient = createFakeAuthClient();
  const service = new AuthService(() => fakeClient);

  await service.signOut();

  assert.equal(fakeClient.signOutCalls, 1);
  assert.equal(await service.getSession(), null);
});

test('the server verifier accepts claims from the configured Supabase issuer', async () => {
  const verifier = createSupabaseAccessTokenVerifier({
    claimsClient: {
      getClaims: async (accessToken) => ({
        data: {
          claims: {
            aud: 'authenticated',
            exp: 2_000_000_000,
            iat: 1_999_996_400,
            iss: 'https://project.supabase.co/auth/v1',
            sub: USER_ID,
          },
          header: { alg: 'RS256', kid: 'test', typ: 'JWT' },
          signature: new Uint8Array(),
        },
        error: null,
      }),
    },
    publishableKey: 'publishable-key',
    supabaseUrl: 'https://project.supabase.co',
  });

  assert.deepEqual(await verifier('verified-token'), { id: USER_ID });
});

test('the server verifier rejects claims from another issuer', async () => {
  const verifier = createSupabaseAccessTokenVerifier({
    claimsClient: {
      getClaims: async () => ({
        data: {
          claims: {
            aud: 'authenticated',
            exp: 2_000_000_000,
            iat: 1_999_996_400,
            iss: 'https://different-project.supabase.co/auth/v1',
            sub: USER_ID,
          },
          header: { alg: 'RS256', kid: 'test', typ: 'JWT' },
          signature: new Uint8Array(),
        },
        error: null,
      }),
    },
    publishableKey: 'publishable-key',
    supabaseUrl: 'https://project.supabase.co',
  });

  await assert.rejects(verifier('wrong-issuer-token'), InvalidAccessTokenError);
});
