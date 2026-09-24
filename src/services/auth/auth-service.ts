import type { Session, SupabaseClient, User } from '@supabase/supabase-js';

import { getSupabaseClient } from './supabase-client';
import type { AuthenticatedUser, AuthSession } from './auth-types';

type AuthClient = Pick<SupabaseClient, 'auth'>;
type AuthStateListener = (session: AuthSession | null) => void;

function toAuthenticatedUser(user: User): AuthenticatedUser {
  return {
    ...(user.email ? { email: user.email } : {}),
    id: user.id,
  };
}

function toAuthSession(session: Session | null): AuthSession | null {
  return session
    ? {
        accessToken: session.access_token,
        user: toAuthenticatedUser(session.user),
      }
    : null;
}

export class AuthService {
  private readonly getClient: () => AuthClient;

  constructor(getClient: () => AuthClient = getSupabaseClient) {
    this.getClient = getClient;
  }

  async getAccessToken() {
    const session = await this.getSession();
    return session?.accessToken ?? null;
  }

  async getAuthenticatedUser() {
    const session = await this.getSession();
    return session?.user ?? null;
  }

  async getSession() {
    const { data, error } = await this.getClient().auth.getSession();

    if (error) {
      throw error;
    }

    return toAuthSession(data.session);
  }

  onAuthStateChange(listener: AuthStateListener) {
    const { data } = this.getClient().auth.onAuthStateChange((_event, session) => {
      listener(toAuthSession(session));
    });

    return () => data.subscription.unsubscribe();
  }

  async signInWithPassword(email: string, password: string) {
    const { data, error } = await this.getClient().auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      throw error;
    }

    return toAuthSession(data.session);
  }

  async signOut() {
    const { error } = await this.getClient().auth.signOut();

    if (error) {
      throw error;
    }
  }

  startAutoRefresh() {
    this.getClient().auth.startAutoRefresh();
  }

  stopAutoRefresh() {
    this.getClient().auth.stopAutoRefresh();
  }
}

export const authService = new AuthService();
