import type {
  AssistantErrorCode,
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

type ParsedBody =
  | { body: unknown; status: 'success' }
  | { status: 'invalid' | 'too_large' };

const DEFAULT_MODEL = 'gpt-5.4-mini';
const MAX_REQUEST_BODY_BYTES = 48 * 1024;
const MAX_MESSAGE_COUNT = 50;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_TOTAL_MESSAGE_LENGTH = 30_000;
const MAX_CONTEXT_VALUE_LENGTH = 100;
const MAX_SESSION_ID_LENGTH = 100;

export const ASSISTANT_REQUEST_LIMITS = {
  bodyBytes: MAX_REQUEST_BODY_BYTES,
  messageCount: MAX_MESSAGE_COUNT,
  messageLength: MAX_MESSAGE_LENGTH,
  totalMessageLength: MAX_TOTAL_MESSAGE_LENGTH,
} as const;

function securityHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

function corsHeaders(origin: string) {
  return {
    ...securityHeaders(),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(body: unknown, status: number, origin?: string) {
  return new Response(JSON.stringify(body), {
    headers: origin ? corsHeaders(origin) : securityHeaders(),
    status,
  });
}

function errorResponse(
  code: AssistantErrorCode,
  error: string,
  status: number,
  origin?: string,
) {
  return jsonResponse({ code, error }, status, origin);
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

function isBoundedString(value: unknown, maxLength = MAX_CONTEXT_VALUE_LENGTH) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isAssistantRequest(value: unknown): value is AssistantRequest {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const request = value as Partial<AssistantRequest>;
  const context = request.context;

  if (
    !context ||
    !isBoundedString(context.currentLocalDate) ||
    !isBoundedString(context.currentLocalTime) ||
    !isBoundedString(context.dayOfWeek) ||
    !isBoundedString(context.timezone) ||
    !isBoundedString(request.sessionId, MAX_SESSION_ID_LENGTH) ||
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

async function parseJsonBody(request: Request): Promise<ParsedBody> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return { status: 'invalid' };
  }

  const declaredLength = Number(request.headers.get('Content-Length'));

  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    return { status: 'too_large' };
  }

  if (!request.body) {
    return { status: 'invalid' };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { status: 'too_large' };
      }

      chunks.push(value);
    }
  } catch {
    return { status: 'invalid' };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
      status: 'success',
    };
  } catch {
    return { status: 'invalid' };
  }
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

export async function handleAssistantRequest(
  request: Request,
  options: AssistantHandlerOptions = {},
) {
  const allowedOrigin = normalizeOrigin(options.allowedOrigin ?? process.env.ALLOWED_ORIGIN);
  const requestOrigin = normalizeOrigin(request.headers.get('Origin'));

  if (!allowedOrigin) {
    return errorResponse('assistant_unavailable', 'The assistant is unavailable.', 500);
  }

  if (requestOrigin !== allowedOrigin) {
    return errorResponse('invalid_request', 'The assistant request was rejected.', 403);
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(allowedOrigin), status: 204 });
  }

  if (request.method !== 'POST') {
    return errorResponse('invalid_request', 'The assistant request was rejected.', 405, allowedOrigin);
  }

  const parsedBody = await parseJsonBody(request);

  if (parsedBody.status !== 'success') {
    if (parsedBody.status === 'too_large') {
      return errorResponse(
        'request_too_large',
        'The assistant request is too large.',
        413,
        allowedOrigin,
      );
    }

    return errorResponse('invalid_request', 'The assistant request was invalid.', 400, allowedOrigin);
  }

  const body = parsedBody.body;

  if (!isAssistantRequest(body)) {
    return errorResponse('invalid_request', 'The assistant request was invalid.', 400, allowedOrigin);
  }

  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return errorResponse('assistant_unavailable', 'The assistant is unavailable.', 500, allowedOrigin);
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
          code: 'assistant_unavailable',
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
      return errorResponse(
        'assistant_unavailable',
        'The assistant could not respond.',
        502,
        allowedOrigin,
      );
    }

    return jsonResponse({ content }, 200, allowedOrigin);
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse('assistant_unavailable', 'The assistant request was cancelled.', 499, allowedOrigin);
    }

    console.error('Assistant server request failed.', error);
    return errorResponse(
      'assistant_unavailable',
      'The assistant could not respond.',
      502,
      allowedOrigin,
    );
  }
}

export default {
  fetch: handleAssistantRequest,
};
