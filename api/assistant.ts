import type {
  AssistantErrorCode,
  AssistantMessage,
  AssistantRequest,
} from '../src/services/assistant/assistant-types';
import {
  ASSISTANT_CALENDAR_TOOL_NAMES,
  type AssistantCalendarEvent,
  type AssistantCalendarToolArguments,
  type AssistantCalendarToolCall,
  type AssistantCalendarToolContinuation,
  type AssistantCalendarToolOutput,
  type AssistantCalendarToolResult,
} from '../src/services/assistant/assistant-calendar-tools';
import {
  ASSISTANT_CLIENT_HEADER,
  ASSISTANT_CLIENT_ID,
} from '../src/services/assistant/assistant-transport';

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
    arguments?: unknown;
    call_id?: unknown;
    content?: Array<{
      text?: unknown;
      type?: unknown;
    }>;
    name?: unknown;
    type?: unknown;
  }>;
};

type AssistantApiRequest = AssistantRequest & {
  calendarToolContinuation?: AssistantCalendarToolContinuation;
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
const MAX_TOOL_CALL_COUNT = 4;
const MAX_TOOL_CALL_ID_LENGTH = 100;
const MAX_TOOL_ARGUMENT_LENGTH = 100;
const MAX_TOOL_EVENT_COUNT = 50;
const MAX_TOOL_EVENT_TITLE_LENGTH = 300;
const MAX_TOOL_EVENT_LOCATION_LENGTH = 500;
const MAX_TOOL_RESULT_MESSAGE_LENGTH = 150;
const MAX_CALENDAR_RANGE_DAYS = 366;

const CALENDAR_TOOLS = [
  {
    type: 'function',
    name: 'get_today_calendar_events',
    description:
      "Read today's device calendar events. Use only when the user's request needs today's calendar facts.",
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        includeLocations: {
          type: 'boolean',
          description: 'True only when event locations are needed to answer the question.',
        },
      },
      required: ['includeLocations'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_tomorrow_calendar_events',
    description:
      "Read tomorrow's device calendar events. Use only when the user's request needs tomorrow's calendar facts.",
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        includeLocations: {
          type: 'boolean',
          description: 'True only when event locations are needed to answer the question.',
        },
      },
      required: ['includeLocations'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_next_calendar_event',
    description:
      'Read the next upcoming device calendar event. Use only when the request needs the next event.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        includeLocations: {
          type: 'boolean',
          description: 'True only when the event location is needed to answer the question.',
        },
      },
      required: ['includeLocations'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_calendar_events_in_range',
    description:
      'Read device calendar events in a precise date/time range, including availability questions. Use the authoritative app timezone.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        startDateTime: {
          type: 'string',
          description: 'Inclusive ISO 8601 range start with timezone offset.',
        },
        endDateTime: {
          type: 'string',
          description: 'Exclusive ISO 8601 range end with timezone offset.',
        },
        includeLocations: {
          type: 'boolean',
          description: 'True only when event locations are needed to answer the question.',
        },
      },
      required: ['startDateTime', 'endDateTime', 'includeLocations'],
      additionalProperties: false,
    },
  },
] as const;

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
    'Access-Control-Allow-Headers': `Content-Type, ${ASSISTANT_CLIENT_HEADER}`,
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

function isBoundedString(
  value: unknown,
  maxLength = MAX_CONTEXT_VALUE_LENGTH,
): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function hasOnlyKeys(value: object, allowedKeys: readonly string[]) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isCalendarToolName(
  value: unknown,
): value is AssistantCalendarToolCall['name'] {
  return (
    typeof value === 'string' &&
    ASSISTANT_CALENDAR_TOOL_NAMES.some((name) => name === value)
  );
}

function isValidIsoDate(value: unknown): value is string {
  return (
    isBoundedString(value, MAX_TOOL_ARGUMENT_LENGTH) &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function isCalendarToolArguments(
  value: unknown,
  name: AssistantCalendarToolCall['name'],
): value is AssistantCalendarToolArguments {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const argumentsValue = value as Partial<AssistantCalendarToolArguments>;

  if (
    typeof argumentsValue.includeLocations !== 'boolean' ||
    !hasOnlyKeys(value, ['includeLocations', 'startDateTime', 'endDateTime'])
  ) {
    return false;
  }

  if (name !== 'get_calendar_events_in_range') {
    return (
      argumentsValue.startDateTime === undefined &&
      argumentsValue.endDateTime === undefined
    );
  }

  if (
    !isValidIsoDate(argumentsValue.startDateTime) ||
    !isValidIsoDate(argumentsValue.endDateTime)
  ) {
    return false;
  }

  const rangeLength =
    new Date(argumentsValue.endDateTime).getTime() -
    new Date(argumentsValue.startDateTime).getTime();

  return (
    rangeLength > 0 &&
    rangeLength <= MAX_CALENDAR_RANGE_DAYS * 24 * 60 * 60 * 1_000
  );
}

function isCalendarToolCall(value: unknown): value is AssistantCalendarToolCall {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const call = value as Partial<AssistantCalendarToolCall>;
  return (
    hasOnlyKeys(value, ['arguments', 'callId', 'name']) &&
    isBoundedString(call.callId, MAX_TOOL_CALL_ID_LENGTH) &&
    isCalendarToolName(call.name) &&
    isCalendarToolArguments(call.arguments, call.name)
  );
}

function isCalendarEvent(value: unknown): value is AssistantCalendarEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const event = value as Partial<AssistantCalendarEvent>;
  return (
    hasOnlyKeys(value, ['endTime', 'isAllDay', 'location', 'startTime', 'title']) &&
    isBoundedString(event.title, MAX_TOOL_EVENT_TITLE_LENGTH) &&
    isValidIsoDate(event.startTime) &&
    isValidIsoDate(event.endTime) &&
    typeof event.isAllDay === 'boolean' &&
    (event.location === undefined ||
      isBoundedString(event.location, MAX_TOOL_EVENT_LOCATION_LENGTH))
  );
}

function isCalendarToolResult(value: unknown): value is AssistantCalendarToolResult {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const result = value as Partial<AssistantCalendarToolResult>;

  if (result.status === 'success') {
    return (
      hasOnlyKeys(value, ['events', 'status']) &&
      Array.isArray(result.events) &&
      result.events.length <= MAX_TOOL_EVENT_COUNT &&
      result.events.every(isCalendarEvent)
    );
  }

  return (
    hasOnlyKeys(value, ['message', 'status']) &&
    (result.status === 'denied' ||
      result.status === 'error' ||
      result.status === 'unavailable') &&
    isBoundedString(result.message, MAX_TOOL_RESULT_MESSAGE_LENGTH)
  );
}

function isCalendarToolOutput(value: unknown): value is AssistantCalendarToolOutput {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const output = value as Partial<AssistantCalendarToolOutput>;
  return (
    hasOnlyKeys(value, ['callId', 'result']) &&
    isBoundedString(output.callId, MAX_TOOL_CALL_ID_LENGTH) &&
    isCalendarToolResult(output.result)
  );
}

function isCalendarToolContinuation(
  value: unknown,
): value is AssistantCalendarToolContinuation {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const continuation = value as Partial<AssistantCalendarToolContinuation>;

  if (
    !hasOnlyKeys(value, ['calls', 'outputs']) ||
    !Array.isArray(continuation.calls) ||
    !Array.isArray(continuation.outputs) ||
    continuation.calls.length < 1 ||
    continuation.calls.length > MAX_TOOL_CALL_COUNT ||
    continuation.calls.length !== continuation.outputs.length ||
    !continuation.calls.every(isCalendarToolCall) ||
    !continuation.outputs.every(isCalendarToolOutput)
  ) {
    return false;
  }

  const callIds = new Set(continuation.calls.map((call) => call.callId));
  return (
    callIds.size === continuation.calls.length &&
    continuation.outputs.every((output) => callIds.has(output.callId))
  );
}

function isAssistantRequest(value: unknown): value is AssistantApiRequest {
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

  const messagesAreValid =
    request.messages.reduce((total, message) => total + message.content.length, 0) <=
    MAX_TOTAL_MESSAGE_LENGTH;

  if (!messagesAreValid) {
    return false;
  }

  const apiRequest = value as Partial<AssistantApiRequest>;
  return (
    apiRequest.calendarToolContinuation === undefined ||
    isCalendarToolContinuation(apiRequest.calendarToolContinuation)
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
    'Calendar tools read factual application data from the user’s device.',
    'Use a calendar tool only when calendar facts are needed to answer the current request.',
    'Never invent calendar events or availability.',
    'Treat returned calendar results as authoritative and do not claim access when a tool says it is unavailable or denied.',
    'If device calendar access is unavailable, explain naturally that it is available in the native app.',
    'Do not ask for event locations unless location is necessary for the answer.',
  ].join('\n');
}

function createOpenAIInput(request: AssistantApiRequest) {
  const input: unknown[] = request.messages.map((message) => ({
    content: message.content,
    role: message.role,
  }));
  const continuation = request.calendarToolContinuation;

  if (!continuation) {
    return input;
  }

  for (const call of continuation.calls) {
    input.push({
      arguments: JSON.stringify(call.arguments),
      call_id: call.callId,
      name: call.name,
      type: 'function_call',
    });
  }

  for (const output of continuation.outputs) {
    input.push({
      call_id: output.callId,
      output: JSON.stringify(output.result),
      type: 'function_call_output',
    });
  }

  return input;
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

function extractCalendarToolCalls(
  response: OpenAIResponse,
): AssistantCalendarToolCall[] | null {
  const rawCalls = (response.output ?? []).filter(
    (item) => item.type === 'function_call',
  );

  if (rawCalls.length === 0) {
    return [];
  }

  if (rawCalls.length > MAX_TOOL_CALL_COUNT) {
    return null;
  }

  const calls: AssistantCalendarToolCall[] = [];

  for (const rawCall of rawCalls) {
    if (
      !isBoundedString(rawCall.call_id, MAX_TOOL_CALL_ID_LENGTH) ||
      !isCalendarToolName(rawCall.name) ||
      typeof rawCall.arguments !== 'string'
    ) {
      return null;
    }

    let parsedArguments: unknown;

    try {
      parsedArguments = JSON.parse(rawCall.arguments) as unknown;
    } catch {
      return null;
    }

    if (!isCalendarToolArguments(parsedArguments, rawCall.name)) {
      return null;
    }

    calls.push({
      arguments: parsedArguments,
      callId: rawCall.call_id,
      name: rawCall.name,
    });
  }

  return calls;
}

export async function handleAssistantRequest(
  request: Request,
  options: AssistantHandlerOptions = {},
) {
  const allowedOrigin = normalizeOrigin(options.allowedOrigin ?? process.env.ALLOWED_ORIGIN);
  const rawRequestOrigin = request.headers.get('Origin');
  const requestOrigin = normalizeOrigin(rawRequestOrigin);

  if (!allowedOrigin) {
    return errorResponse('assistant_unavailable', 'The assistant is unavailable.', 500);
  }

  const isAllowedBrowserRequest = requestOrigin === allowedOrigin;
  const isAllowedNativeRequest =
    rawRequestOrigin === null &&
    request.headers.get(ASSISTANT_CLIENT_HEADER) === ASSISTANT_CLIENT_ID;

  if (!isAllowedBrowserRequest && !isAllowedNativeRequest) {
    return errorResponse('invalid_request', 'The assistant request was rejected.', 403);
  }

  const responseOrigin = isAllowedBrowserRequest ? allowedOrigin : undefined;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(allowedOrigin), status: 204 });
  }

  if (request.method !== 'POST') {
    return errorResponse('invalid_request', 'The assistant request was rejected.', 405, responseOrigin);
  }

  const parsedBody = await parseJsonBody(request);

  if (parsedBody.status !== 'success') {
    if (parsedBody.status === 'too_large') {
      return errorResponse(
        'request_too_large',
        'The assistant request is too large.',
        413,
        responseOrigin,
      );
    }

    return errorResponse('invalid_request', 'The assistant request was invalid.', 400, responseOrigin);
  }

  const body = parsedBody.body;

  if (!isAssistantRequest(body)) {
    return errorResponse('invalid_request', 'The assistant request was invalid.', 400, responseOrigin);
  }

  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return errorResponse('assistant_unavailable', 'The assistant is unavailable.', 500, responseOrigin);
  }

  const fetchImplementation = options.fetchImplementation ?? fetch;

  try {
    const openAIResult = await fetchImplementation('https://api.openai.com/v1/responses', {
      body: JSON.stringify({
        input: createOpenAIInput(body),
        instructions: createInstructions(body),
        max_output_tokens: 600,
        model: options.model ?? DEFAULT_MODEL,
        reasoning: { effort: 'none' },
        store: false,
        text: { verbosity: 'low' },
        tool_choice: body.calendarToolContinuation ? 'none' : 'auto',
        tools: CALENDAR_TOOLS,
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
        responseOrigin,
      );
    }

    const toolRequests = extractCalendarToolCalls(openAIResponse);

    if (toolRequests === null) {
      console.error('OpenAI returned an invalid calendar tool request.', {
        requestId: openAIResult.headers.get('x-request-id'),
      });
      return errorResponse(
        'assistant_unavailable',
        'The assistant could not respond.',
        502,
        responseOrigin,
      );
    }

    if (!body.calendarToolContinuation && toolRequests.length > 0) {
      return jsonResponse({ toolRequests }, 200, responseOrigin);
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
        responseOrigin,
      );
    }

    return jsonResponse({ content }, 200, responseOrigin);
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse(
        'assistant_unavailable',
        'The assistant request was cancelled.',
        499,
        responseOrigin,
      );
    }

    console.error('Assistant server request failed.', error);
    return errorResponse(
      'assistant_unavailable',
      'The assistant could not respond.',
      502,
      responseOrigin,
    );
  }
}

export default {
  fetch: handleAssistantRequest,
};
