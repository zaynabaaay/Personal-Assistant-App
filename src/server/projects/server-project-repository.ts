import { createClient } from '@supabase/supabase-js';

import { SupabaseProjectRepository } from '../../services/projects/supabase-project-repository';

declare const process: {
  env: Record<string, string | undefined>;
};

export type ServerProjectRepositoryContext = {
  accessToken: string;
  userId: string;
};

export class ServerProjectConfigurationError extends Error {
  constructor() {
    super('Server Project persistence is not configured.');
    this.name = 'ServerProjectConfigurationError';
  }
}

export function createServerProjectRepository(
  context: ServerProjectRepositoryContext,
) {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!supabaseUrl || !publishableKey || !context.accessToken || !context.userId) {
    throw new ServerProjectConfigurationError();
  }

  const client = createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: { Authorization: `Bearer ${context.accessToken}` },
    },
  });

  // The verified ID narrows every query explicitly. The user's JWT is also
  // forwarded so Supabase RLS independently enforces the same ownership scope.
  return new SupabaseProjectRepository(() => client, context.userId);
}
