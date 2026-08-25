import {
  ASSISTANT_CLIENT_HEADER,
  ASSISTANT_CLIENT_ID,
} from '../../contracts/assistant';
import {
  MemoryProcessingInProgressError,
  MemoryProcessor,
} from '../../services/memory/memory-processor';
import { SupabaseMemoryRepository } from '../../services/memory/supabase-memory-repository';
import type { AccessTokenVerifier } from '../auth/authenticated-user';
import {
  createSupabaseAccessTokenVerifier,
  InvalidAccessTokenError,
  SupabaseAuthUnavailableError,
} from '../auth/supabase-token-verifier';
import { createServerSupabaseClient } from '../projects/server-project-repository';

import { OpenAIMemoryAnalyzer } from './openai-memory-analyzer';

declare const process: { env: Record<string, string | undefined> };

type Processor = Pick<MemoryProcessor, 'process'>;
type HandlerOptions = {
  allowedOrigin?: string;
  apiKey?: string;
  createProcessor?: (context: { accessToken: string; userId: string }) => Processor;
  verifyAccessToken?: AccessTokenVerifier;
};

function normalizeOrigin(value: string | null | undefined) {
  if (!value) return null;
  try { return new URL(value.trim()).origin; } catch { return null; }
}

function headers(origin?: string) {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    ...(origin ? {
      'Access-Control-Allow-Headers': `Authorization, Content-Type, ${ASSISTANT_CLIENT_HEADER}`,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    } : {}),
  };
}

function json(body: unknown, status: number, origin?: string) {
  return new Response(JSON.stringify(body), { headers: headers(origin), status });
}

function bearerToken(request: Request) {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') ?? '');
  return match?.[1] ?? null;
}

const defaultVerify = createSupabaseAccessTokenVerifier();

export async function handleMemoryProcessing(request: Request, options: HandlerOptions = {}) {
  const allowedOrigin = normalizeOrigin(options.allowedOrigin ?? process.env.ALLOWED_ORIGIN);
  const rawOrigin = request.headers.get('Origin');
  const browser = normalizeOrigin(rawOrigin) === allowedOrigin;
  const native = rawOrigin === null &&
    request.headers.get(ASSISTANT_CLIENT_HEADER) === ASSISTANT_CLIENT_ID;
  if (!allowedOrigin) return json({ error: 'Memory processing is unavailable.' }, 500);
  if (!browser && !native) return json({ error: 'Request rejected.' }, 403);
  const responseOrigin = browser ? allowedOrigin : undefined;
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: headers(allowedOrigin), status: 204 });
  }
  if (request.method !== 'POST') return json({ error: 'Request rejected.' }, 405, responseOrigin);

  const accessToken = bearerToken(request);
  if (!accessToken) return json({ error: 'Authentication is required.' }, 401, responseOrigin);
  let user;
  try {
    user = await (options.verifyAccessToken ?? defaultVerify)(accessToken);
  } catch (error) {
    if (error instanceof SupabaseAuthUnavailableError) {
      return json({ error: 'Memory processing is unavailable.' }, 500, responseOrigin);
    }
    if (!(error instanceof InvalidAccessTokenError)) console.error('Memory authentication failed.');
    return json({ error: 'Authentication is required.' }, 401, responseOrigin);
  }

  const raw = await request.text();
  if (raw.length > 2_000) return json({ error: 'Request is too large.' }, 413, responseOrigin);
  let conversationId: string | undefined;
  try {
    const body = JSON.parse(raw) as { conversationId?: unknown };
    if (body.conversationId !== undefined) {
      conversationId = typeof body.conversationId === 'string' && body.conversationId.trim() &&
        body.conversationId.length <= 300 ? body.conversationId : undefined;
      if (!conversationId) return json({ error: 'Conversation ID is invalid.' }, 400, responseOrigin);
    }
  } catch {
    return json({ error: 'The request is invalid.' }, 400, responseOrigin);
  }

  try {
    const processor = options.createProcessor?.({ accessToken, userId: user.id }) ??
      createProcessor({ accessToken, userId: user.id }, options.apiKey);
    const result = await processor.process(conversationId);
    return json(result, result.status === 'partial' ? 202 : 200, responseOrigin);
  } catch (error) {
    if (error instanceof MemoryProcessingInProgressError ||
      (error instanceof Error && error.name === 'MemoryProcessingInProgressError')) {
      return json({ status: 'processing' }, 202, responseOrigin);
    }
    console.error('General memory processing failed.', error);
    return json({ error: 'Memory processing failed.' }, 502, responseOrigin);
  }
}

function createProcessor(
  context: { accessToken: string; userId: string },
  configuredApiKey?: string,
) {
  const apiKey = configuredApiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI is not configured.');
  const client = createServerSupabaseClient(context);
  return new MemoryProcessor(
    new OpenAIMemoryAnalyzer({ apiKey }),
    new SupabaseMemoryRepository(() => client),
  );
}
