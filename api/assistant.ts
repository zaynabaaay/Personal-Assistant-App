import type {
  AssistantMessage,
  AssistantRequest,
} from '../src/services/assistant/assistant-types';

declare const process: {
  env: Record<string, string | undefined>;
};

type OpenAIResponse = {
  error?: {
    code?: unknown;
    message?: unknown;
    type?: unknown;
  };
  output?: Array<{
    content?: Array<{
      text?: unknown;
      type?: unknown;
    }>;
    type?: unknown;
  }>;
};

type AssistantHandlerOptions = {
  allowedOrigin?: string;
  apiKey?: string;
  fetchImplementation?: typeof fetch;
  model?: string;
};

const DEFAULT_MODEL = 'gpt-5.4-mini';
const MAX_MESSAGE_COUNT = 50;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_TOTAL_MESSAGE_LENGTH = 30_000;
const SAFE_OPENAI_ERROR_CODES = new Set([
  'billing_not_active',
  'insufficient_quota',
  'invalid_api_key',
  'model_not_found',
  'permission_denied',
  'rate_limit_exceeded',
]);

function corsHeaders(origin: string) {
  return {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json',
    Vary: 'Origin',
  };
}

function jsonResponse(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    headers: corsHeaders(origin),
    status,
  });
}

function normalizeOrigin(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const message = value as Partial<AssistantMessage>;
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    message.content.length > 0 &&
    message.content.length <= MAX_MESSAGE_LENGTH
  );
}

function isAssistantRequest(value: unknown): value is AssistantRequest {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const request = value as Partial<AssistantRequest>;
  const context = request.context;

  if (
    !context ||
    typeof context.currentLocalDate !== 'string' ||
    typeof context.currentLocalTime !== 'string' ||
    typeof context.dayOfWeek !== 'string' ||
    typeof context.timezone !== 'string' ||
    typeof request.sessionId !== 'string' ||
    !Array.isArray(request.messages) ||
    request.messages.length < 1 ||
    request.messages.length > MAX_MESSAGE_COUNT ||
    !request.messages.every(isAssistantMessage)
  ) {
    return false;
  }

  return (
    request.messages.reduce((total, message) => total + message.content.length, 0) <=
    MAX_TOTAL_MESSAGE_LENGTH
  );
}

function createInstructions(request: AssistantRequest) {
  const { context } = request;

  return [
    'You are a personal life assistant.',
    'Be conversational and concise by default.',
    'Do not pretend to know personal information the user has not provided.',
    'When you do not have enough information, say so naturally.',
    'Treat the following app-supplied current context as authoritative:',
    `Local date: ${context.currentLocalDate}`,
    `Local time: ${context.currentLocalTime}`,
    `Weekday: ${context.dayOfWeek}`,
    `Timezone: ${context.timezone}`,
  ].join('\n');
}

function extractOutputText(response: OpenAIResponse) {
  return (response.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === 'output_text' && typeof content.text === 'string')
    .map((content) => content.text as string)
    .join('\n')
    .trim();
}

function getSafeOpenAIErrorCode(response: OpenAIResponse) {
  const candidate =
    typeof response.error?.code === 'string'
      ? response.error.code
      : typeof response.error?.type === 'string'
        ? response.error.type
        : null;

  return candidate && SAFE_OPENAI_ERROR_CODES.has(candidate) ? candidate : 'provider_error';
}

export async function handleAssistantRequest(
  request: Request,
  options: AssistantHandlerOptions = {},
) {
  const allowedOrigin = normalizeOrigin(options.allowedOrigin ?? process.env.ALLOWED_ORIGIN);
  const requestOrigin = normalizeOrigin(request.headers.get('Origin'));

  if (!allowedOrigin) {
    return new Response(JSON.stringify({ error: 'The assistant server is not configured.' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500,
    });
  }

  if (requestOrigin !== allowedOrigin) {
    return new Response(JSON.stringify({ error: 'Origin not allowed.' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 403,
    });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(allowedOrigin), status: 204 });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, allowedOrigin);
  }

  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return jsonResponse({ error: 'The assistant server is not configured.' }, 500, allowedOrigin);
  }

  const body = await request.json().catch(() => null);

  if (!isAssistantRequest(body)) {
    return jsonResponse({ error: 'Invalid assistant request.' }, 400, allowedOrigin);
  }

  const fetchImplementation = options.fetchImplementation ?? fetch;

  try {
    const openAIResult = await fetchImplementation('https://api.openai.com/v1/responses', {
      body: JSON.stringify({
        input: body.messages.map((message) => ({
          content: message.content,
          role: message.role,
        })),
        instructions: createInstructions(body),
        max_output_tokens: 600,
        model: options.model ?? DEFAULT_MODEL,
        reasoning: { effort: 'none' },
        store: false,
        text: { verbosity: 'low' },
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: request.signal,
    });
    const openAIResponse = (await openAIResult.json().catch(() => ({}))) as OpenAIResponse;

    if (!openAIResult.ok) {
      console.error('OpenAI request failed.', {
        message: openAIResponse.error?.message,
        requestId: openAIResult.headers.get('x-request-id'),
        status: openAIResult.status,
      });
      return jsonResponse(
        {
          code: getSafeOpenAIErrorCode(openAIResponse),
          error: 'The assistant could not respond.',
        },
        502,
        allowedOrigin,
      );
    }

    const content = extractOutputText(openAIResponse);

    if (!content) {
      console.error('OpenAI returned no assistant text.', {
        requestId: openAIResult.headers.get('x-request-id'),
      });
      return jsonResponse({ error: 'The assistant returned an empty response.' }, 502, allowedOrigin);
    }

    return jsonResponse({ content }, 200, allowedOrigin);
  } catch (error) {
    if (request.signal.aborted) {
      return jsonResponse({ error: 'Request cancelled.' }, 499, allowedOrigin);
    }

    console.error('Assistant server request failed.', error);
    return jsonResponse({ error: 'The assistant could not respond.' }, 502, allowedOrigin);
  }
}

export default {
  fetch: handleAssistantRequest,
};
