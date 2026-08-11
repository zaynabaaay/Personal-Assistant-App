import type { AssistantErrorCode, AssistantProvider } from './assistant-types';

declare const process: {
  env: Record<string, string | undefined>;
};

type AssistantApiResponse = {
  code?: unknown;
  content?: unknown;
};

const DEFAULT_ASSISTANT_API_URL =
  'https://personal-assistant-app-ten.vercel.app/api/assistant';
const ASSISTANT_API_URL =
  process.env.EXPO_PUBLIC_ASSISTANT_API_URL ?? DEFAULT_ASSISTANT_API_URL;
const ERROR_MESSAGES: Record<AssistantErrorCode, string> = {
  assistant_unavailable: 'The assistant could not respond. Please try again.',
  invalid_request: 'The assistant request was invalid.',
  rate_limited: 'Too many requests. Please wait a moment and try again.',
  request_too_large: 'That conversation is too large to send.',
};

function isAssistantErrorCode(value: unknown): value is AssistantErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_MESSAGES, value);
}

function getErrorCode(response: Response, body: AssistantApiResponse): AssistantErrorCode {
  if (response.status === 429) {
    return 'rate_limited';
  }

  if (response.status === 413) {
    return 'request_too_large';
  }

  if (isAssistantErrorCode(body.code)) {
    return body.code;
  }

  return response.status === 400 ? 'invalid_request' : 'assistant_unavailable';
}

export class AssistantApiClientError extends Error {
  readonly code: AssistantErrorCode;

  constructor(code: AssistantErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
    this.name = 'AssistantApiClientError';
  }
}

export const assistantApiClient: AssistantProvider = async (request, signal) => {
  const response = await fetch(ASSISTANT_API_URL, {
    body: JSON.stringify(request),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as AssistantApiResponse;

  if (!response.ok) {
    throw new AssistantApiClientError(getErrorCode(response, body));
  }

  if (typeof body.content !== 'string' || !body.content.trim()) {
    throw new AssistantApiClientError('assistant_unavailable');
  }

  return body.content.trim();
};
