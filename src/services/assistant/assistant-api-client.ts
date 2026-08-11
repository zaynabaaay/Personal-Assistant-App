import type { AssistantErrorCode, AssistantProvider } from './assistant-types';
import type {
  AssistantCalendarToolCall,
  AssistantCalendarToolContinuation,
} from './assistant-calendar-tools';
import { ASSISTANT_CALENDAR_TOOL_NAMES } from './assistant-calendar-tools';
import { executeAssistantCalendarTool } from './assistant-calendar-executor';
import { ASSISTANT_CLIENT_HEADER, ASSISTANT_CLIENT_ID } from './assistant-transport';

declare const process: {
  env: Record<string, string | undefined>;
};

type AssistantApiResponse = {
  code?: unknown;
  content?: unknown;
  toolRequests?: unknown;
};

type AssistantApiRequest = Parameters<AssistantProvider>[0] & {
  calendarToolContinuation?: AssistantCalendarToolContinuation;
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

function isCalendarToolCall(value: unknown): value is AssistantCalendarToolCall {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const call = value as Partial<AssistantCalendarToolCall>;
  return (
    typeof call.callId === 'string' &&
    ASSISTANT_CALENDAR_TOOL_NAMES.some((name) => name === call.name) &&
    !!call.arguments &&
    typeof call.arguments === 'object' &&
    typeof call.arguments.includeLocations === 'boolean'
  );
}

async function postAssistantRequest(
  request: AssistantApiRequest,
  signal: AbortSignal,
  fetchImplementation: typeof fetch,
) {
  const response = await fetchImplementation(ASSISTANT_API_URL, {
    body: JSON.stringify(request),
    headers: {
      [ASSISTANT_CLIENT_HEADER]: ASSISTANT_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    method: 'POST',
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as AssistantApiResponse;

  if (!response.ok) {
    throw new AssistantApiClientError(getErrorCode(response, body));
  }

  return body;
}

export function createAssistantApiClient(
  fetchImplementation?: typeof fetch,
  executeTool = executeAssistantCalendarTool,
): AssistantProvider {
  return async (request, signal) => {
    const requestFetch = fetchImplementation ?? fetch;
    const initialResponse = await postAssistantRequest(
      request,
      signal,
      requestFetch,
    );

    if (typeof initialResponse.content === 'string' && initialResponse.content.trim()) {
      return initialResponse.content.trim();
    }

    if (
      !Array.isArray(initialResponse.toolRequests) ||
      initialResponse.toolRequests.length < 1 ||
      !initialResponse.toolRequests.every(isCalendarToolCall)
    ) {
      throw new AssistantApiClientError('assistant_unavailable');
    }

    const calls = initialResponse.toolRequests;
    const outputs = await Promise.all(calls.map((call) => executeTool(call)));
    const finalResponse = await postAssistantRequest(
      {
        ...request,
        calendarToolContinuation: { calls, outputs },
      },
      signal,
      requestFetch,
    );

    if (typeof finalResponse.content !== 'string' || !finalResponse.content.trim()) {
      throw new AssistantApiClientError('assistant_unavailable');
    }

    return finalResponse.content.trim();
  };
}

export const assistantApiClient = createAssistantApiClient();
