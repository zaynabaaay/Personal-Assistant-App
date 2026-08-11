import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_REQUEST_LIMITS,
  handleAssistantRequest as handleUnauthenticatedAssistantRequest,
} from '../api/assistant.ts';
import { MAX_ASSISTANT_TOOL_STEPS } from '../src/contracts/assistant/tool-contract.ts';
import {
  AssistantApiClientError,
  createAssistantApiClient as createUnauthenticatedAssistantApiClient,
} from '../src/services/assistant/assistant-api-client.ts';
import { createAssistantCalendarToolExecutor } from '../src/services/assistant/assistant-calendar-executor.ts';
import { AssistantService } from '../src/services/assistant/assistant-service.ts';
import {
  ASSISTANT_CLIENT_HEADER,
  ASSISTANT_CLIENT_ID,
} from '../src/contracts/assistant/assistant-contract.ts';
import { InvalidAccessTokenError } from '../src/server/auth/supabase-token-verifier.ts';

const ALLOWED_ORIGIN = 'https://example.com';
const TEST_ACCESS_TOKEN = 'test-supabase-access-token';
const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const BASE_REQUEST = {
  context: {
    currentLocalDate: 'August 11, 2026',
    currentLocalTime: '9:00:00 AM',
    dayOfWeek: 'Tuesday',
    timezone: 'America/Toronto',
  },
  messages: [{ content: 'Hello.', role: 'user' }],
  sessionId: 'assistant-session-test',
};

async function verifyTestAccessToken(accessToken) {
  if (accessToken !== TEST_ACCESS_TOKEN) {
    throw new InvalidAccessTokenError();
  }

  return { id: TEST_USER_ID };
}

function handleAssistantRequest(request, options = {}) {
  return handleUnauthenticatedAssistantRequest(request, {
    verifyAccessToken: verifyTestAccessToken,
    ...options,
  });
}

function createAssistantApiClient(fetchImplementation, executeTool) {
  return createUnauthenticatedAssistantApiClient(
    fetchImplementation,
    executeTool,
    async () => TEST_ACCESS_TOKEN,
  );
}

function assistantRequest(body, headers = {}) {
  return new Request('https://assistant.example/api/assistant', {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
      Origin: ALLOWED_ORIGIN,
      ...headers,
    },
    method: 'POST',
  });
}

function successfulOpenAIResponse(content = 'Hello!') {
  return new Response(
    JSON.stringify({
      output: [
        {
          content: [{ text: content, type: 'output_text' }],
          type: 'message',
        },
      ],
    }),
    { headers: { 'Content-Type': 'application/json', 'x-request-id': 'request-test' } },
  );
}

function calendarToolOpenAIResponse({
  arguments: toolArguments = { includeLocations: false },
  callId = 'calendar-call-1',
  name = 'get_today_calendar_events',
} = {}) {
  return new Response(
    JSON.stringify({
      output: [
        {
          arguments: JSON.stringify(toolArguments),
          call_id: callId,
          name,
          type: 'function_call',
        },
      ],
    }),
    { headers: { 'Content-Type': 'application/json', 'x-request-id': 'request-tool' } },
  );
}

function calendarToolCall(index, name = 'get_today_calendar_events') {
  return {
    arguments: { includeLocations: false },
    callId: `calendar-call-${index}`,
    execution: 'client',
    name,
  };
}

function calendarToolOutput(call) {
  return {
    callId: call.callId,
    execution: call.execution,
    name: call.name,
    result: { events: [], status: 'success' },
  };
}

function pendingCalendarResponse(index, name) {
  return {
    completedToolSteps: [],
    pendingToolStep: {
      calls: [calendarToolCall(index, name)],
      outputs: [],
    },
    status: 'requires_client_tools',
  };
}

function nativeAssistantRequest(body, headers = {}) {
  return new Request('https://assistant.example/api/assistant', {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      [ASSISTANT_CLIENT_HEADER]: ASSISTANT_CLIENT_ID,
      Authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    method: 'POST',
  });
}

test('normal chat reaches OpenAI with the existing conversation and safe settings', async () => {
  let openAIRequest;
  const response = await handleAssistantRequest(assistantRequest(BASE_REQUEST), {
    allowedOrigin: ALLOWED_ORIGIN,
    apiKey: 'test-key',
    fetchImplementation: async (_url, init) => {
      openAIRequest = JSON.parse(String(init?.body));
      return successfulOpenAIResponse('Assistant reply');
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    content: 'Assistant reply',
    status: 'completed',
  });
  assert.deepEqual(openAIRequest.input, BASE_REQUEST.messages);
  assert.equal(openAIRequest.store, false);
  assert.match(openAIRequest.instructions, /America\/Toronto/);
  assert.equal(openAIRequest.tool_choice, 'auto');
  assert.deepEqual(
    openAIRequest.tools.map((tool) => tool.name),
    [
      'get_today_calendar_events',
      'get_tomorrow_calendar_events',
      'get_next_calendar_event',
      'get_calendar_events_in_range',
    ],
  );
});

test('the backend returns a validated calendar tool request without querying a calendar', async () => {
  const response = await handleAssistantRequest(assistantRequest(BASE_REQUEST), {
    allowedOrigin: ALLOWED_ORIGIN,
    apiKey: 'test-key',
    fetchImplementation: async () => calendarToolOpenAIResponse(),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    completedToolSteps: [],
    pendingToolStep: {
      calls: [{
        arguments: { includeLocations: false },
        callId: 'calendar-call-1',
        execution: 'client',
        name: 'get_today_calendar_events',
      }],
      outputs: [],
    },
    status: 'requires_client_tools',
  });
});

test('calendar tool results are supplied to OpenAI without persistence', async () => {
  const requestBody = {
    ...BASE_REQUEST,
    toolContinuation: {
      steps: [{
        calls: [
          {
            arguments: { includeLocations: false },
            callId: 'calendar-call-1',
            execution: 'client',
            name: 'get_today_calendar_events',
          },
        ],
        outputs: [
          {
            callId: 'calendar-call-1',
            execution: 'client',
            name: 'get_today_calendar_events',
            result: {
              events: [
                {
                  endTime: '2026-08-11T22:00:00.000Z',
                  isAllDay: false,
                  startTime: '2026-08-11T21:00:00.000Z',
                  title: 'Test Personal Assistant',
                },
              ],
              status: 'success',
            },
          },
        ],
      }],
    },
  };
  let openAIRequest;
  const response = await handleAssistantRequest(assistantRequest(requestBody), {
    allowedOrigin: ALLOWED_ORIGIN,
    apiKey: 'test-key',
    fetchImplementation: async (_url, init) => {
      openAIRequest = JSON.parse(String(init?.body));
      return successfulOpenAIResponse('You have one event at 5 PM.');
    },
  });

  assert.equal(response.status, 200);
  assert.equal(openAIRequest.store, false);
  assert.equal(openAIRequest.tool_choice, 'auto');
  assert.deepEqual(openAIRequest.input.slice(-2), [
    {
      arguments: JSON.stringify({ includeLocations: false }),
      call_id: 'calendar-call-1',
      name: 'get_today_calendar_events',
      type: 'function_call',
    },
    {
      call_id: 'calendar-call-1',
      output: JSON.stringify(requestBody.toolContinuation.steps[0].outputs[0].result),
      type: 'function_call_output',
    },
  ]);
  assert.doesNotMatch(
    openAIRequest.input.at(-1).output,
    /calendarName|description|notes|event-id/,
  );
});

test('calendar metadata outside the allowed minimum fields is rejected', async () => {
  const requestBody = {
    ...BASE_REQUEST,
    toolContinuation: {
      steps: [{
        calls: [
          {
            arguments: { includeLocations: false },
            callId: 'calendar-call-1',
            execution: 'client',
            name: 'get_today_calendar_events',
          },
        ],
        outputs: [
          {
            callId: 'calendar-call-1',
            execution: 'client',
            name: 'get_today_calendar_events',
            result: {
              events: [
                {
                  endTime: '2026-08-11T22:00:00.000Z',
                  id: 'private-event-id',
                  isAllDay: false,
                  startTime: '2026-08-11T21:00:00.000Z',
                  title: 'Test event',
                },
              ],
              status: 'success',
            },
          },
        ],
      }],
    },
  };
  const response = await handleAssistantRequest(assistantRequest(requestBody), {
    allowedOrigin: ALLOWED_ORIGIN,
    apiKey: 'test-key',
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_request');
});

test('the app client queries calendar only after the backend requests a tool', async () => {
  const postedBodies = [];
  const authorizationHeaders = [];
  let toolExecutions = 0;
  const responses = [
    {
      completedToolSteps: [],
      pendingToolStep: {
        calls: [{
          arguments: { includeLocations: false },
          callId: 'calendar-call-1',
          execution: 'client',
          name: 'get_today_calendar_events',
        }],
        outputs: [],
      },
      status: 'requires_client_tools',
    },
    { content: 'You have one event at 5 PM.', status: 'completed' },
  ];
  const client = createAssistantApiClient(
    async (_url, init) => {
      postedBodies.push(JSON.parse(String(init?.body)));
      authorizationHeaders.push(new Headers(init?.headers).get('Authorization'));
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    },
    async (call) => {
      toolExecutions += 1;
      return {
        callId: call.callId,
        execution: call.execution,
        name: call.name,
        result: {
          events: [
            {
              endTime: '2026-08-11T22:00:00.000Z',
              isAllDay: false,
              startTime: '2026-08-11T21:00:00.000Z',
              title: 'Test Personal Assistant',
            },
          ],
          status: 'success',
        },
      };
    },
  );

  const content = await client(BASE_REQUEST, new AbortController().signal);

  assert.equal(content, 'You have one event at 5 PM.');
  assert.equal(toolExecutions, 1);
  assert.equal(postedBodies.length, 2);
  assert.deepEqual(authorizationHeaders, [
    `Bearer ${TEST_ACCESS_TOKEN}`,
    `Bearer ${TEST_ACCESS_TOKEN}`,
  ]);
  assert.doesNotMatch(JSON.stringify(postedBodies), new RegExp(TEST_ACCESS_TOKEN));
  assert.equal(postedBodies[0].toolContinuation, undefined);
  assert.equal(
    postedBodies[1].toolContinuation.steps[0].outputs[0].result.events[0].id,
    undefined,
  );
});

test('the generic client loop handles multiple sequential tool calls', async () => {
  const postedBodies = [];
  const executedTools = [];
  const responses = [
    pendingCalendarResponse(1, 'get_today_calendar_events'),
    pendingCalendarResponse(2, 'get_next_calendar_event'),
    { content: 'You have one event today, and it is also your next event.', status: 'completed' },
  ];
  const client = createAssistantApiClient(
    async (_url, init) => {
      postedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    },
    async (call) => {
      executedTools.push(call.name);
      return calendarToolOutput(call);
    },
  );

  const content = await client(BASE_REQUEST, new AbortController().signal);

  assert.equal(
    content,
    'You have one event today, and it is also your next event.',
  );
  assert.deepEqual(executedTools, [
    'get_today_calendar_events',
    'get_next_calendar_event',
  ]);
  assert.equal(postedBodies[0].toolContinuation, undefined);
  assert.equal(postedBodies[1].toolContinuation.steps.length, 1);
  assert.equal(postedBodies[2].toolContinuation.steps.length, 2);
});

test('the generic client tool loop stops at the configured maximum', async () => {
  let requestCount = 0;
  let executionCount = 0;
  const client = createAssistantApiClient(
    async () => {
      requestCount += 1;
      return new Response(
        JSON.stringify(pendingCalendarResponse(requestCount)),
        { status: 200 },
      );
    },
    async (call) => {
      executionCount += 1;
      return calendarToolOutput(call);
    },
  );

  await assert.rejects(
    client(BASE_REQUEST, new AbortController().signal),
    (error) =>
      error instanceof AssistantApiClientError &&
      error.code === 'assistant_unavailable',
  );
  assert.equal(executionCount, MAX_ASSISTANT_TOOL_STEPS);
  assert.equal(requestCount, MAX_ASSISTANT_TOOL_STEPS + 1);
});

test('the backend refuses another tool step after the configured maximum', async () => {
  const steps = Array.from({ length: MAX_ASSISTANT_TOOL_STEPS }, (_, index) => {
    const call = calendarToolCall(index + 1);
    return { calls: [call], outputs: [calendarToolOutput(call)] };
  });
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    const response = await handleAssistantRequest(
      assistantRequest({
        ...BASE_REQUEST,
        toolContinuation: { steps },
      }),
      {
        allowedOrigin: ALLOWED_ORIGIN,
        apiKey: 'test-key',
        fetchImplementation: async () =>
          calendarToolOpenAIResponse({ callId: 'one-call-too-many' }),
      },
    );

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      code: 'assistant_unavailable',
      error: 'The assistant could not respond.',
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('an unrelated response does not query the device calendar', async () => {
  let toolExecutions = 0;
  const client = createAssistantApiClient(
    async () =>
      new Response(
        JSON.stringify({ content: 'Hello!', status: 'completed' }),
        { status: 200 },
      ),
    async () => {
      toolExecutions += 1;
      throw new Error('Calendar should not be queried.');
    },
  );

  assert.equal(
    await client(BASE_REQUEST, new AbortController().signal),
    'Hello!',
  );
  assert.equal(toolExecutions, 0);
});

test('the web calendar state is returned as a safe native-app explanation input', async () => {
  const unavailableCalendar = {
    findNextUpcomingEvent: async () => ({ message: 'raw message', status: 'unavailable' }),
    getPermissionStatus: async () => ({ message: 'raw message', status: 'unavailable' }),
    readEventsInRange: async () => ({ message: 'raw message', status: 'unavailable' }),
    readTodayEvents: async () => ({ message: 'raw message', status: 'unavailable' }),
    readTomorrowEvents: async () => ({ message: 'raw message', status: 'unavailable' }),
    requestPermission: async () => ({ message: 'raw message', status: 'unavailable' }),
  };
  const executeTool = createAssistantCalendarToolExecutor(unavailableCalendar);
  const output = await executeTool({
    arguments: { includeLocations: false },
    callId: 'calendar-call-1',
    execution: 'client',
    name: 'get_today_calendar_events',
  });

  assert.deepEqual(output, {
    callId: 'calendar-call-1',
    execution: 'client',
    name: 'get_today_calendar_events',
    result: {
      message: 'Device calendar access is available only in the native app.',
      status: 'unavailable',
    },
  });
});

test('calendar events are sanitized before leaving the device', async () => {
  const event = {
    calendarName: 'Private calendar',
    description: 'private description',
    endDate: '2026-08-11T22:00:00.000Z',
    id: 'private-event-id',
    isAllDay: false,
    location: 'Home',
    notes: 'private notes',
    startDate: '2026-08-11T21:00:00.000Z',
    timeZone: 'America/Toronto',
    title: 'Test Personal Assistant',
  };
  const service = {
    findNextUpcomingEvent: async () => ({ data: event, status: 'success' }),
    getPermissionStatus: async () => ({ status: 'granted' }),
    readEventsInRange: async () => ({ data: [event], status: 'success' }),
    readTodayEvents: async () => ({ data: [event], status: 'success' }),
    readTomorrowEvents: async () => ({ data: [event], status: 'success' }),
    requestPermission: async () => ({ status: 'granted' }),
  };
  const executeTool = createAssistantCalendarToolExecutor(service);

  const withoutLocation = await executeTool({
    arguments: { includeLocations: false },
    callId: 'calendar-call-1',
    execution: 'client',
    name: 'get_today_calendar_events',
  });
  const withLocation = await executeTool({
    arguments: { includeLocations: true },
    callId: 'calendar-call-2',
    execution: 'client',
    name: 'get_today_calendar_events',
  });

  assert.deepEqual(withoutLocation.result.events[0], {
    endTime: event.endDate,
    isAllDay: false,
    startTime: event.startDate,
    title: event.title,
  });
  assert.deepEqual(withLocation.result.events[0], {
    endTime: event.endDate,
    isAllDay: false,
    location: 'Home',
    startTime: event.startDate,
    title: event.title,
  });
  assert.doesNotMatch(
    JSON.stringify([withoutLocation, withLocation]),
    /private-event-id|private description|private notes|Private calendar|timeZone/,
  );
});

test('all four read-only calendar tools delegate to the calendar service', async () => {
  const calls = [];
  const success = { data: [], status: 'success' };
  const service = {
    findNextUpcomingEvent: async () => {
      calls.push('next');
      return { data: null, status: 'success' };
    },
    getPermissionStatus: async () => ({ status: 'granted' }),
    readEventsInRange: async (startDate, endDate) => {
      calls.push(['range', startDate.toISOString(), endDate.toISOString()]);
      return success;
    },
    readTodayEvents: async () => {
      calls.push('today');
      return success;
    },
    readTomorrowEvents: async () => {
      calls.push('tomorrow');
      return success;
    },
    requestPermission: async () => ({ status: 'granted' }),
  };
  const executeTool = createAssistantCalendarToolExecutor(service);

  await executeTool({
    arguments: { includeLocations: false },
    callId: 'today',
    execution: 'client',
    name: 'get_today_calendar_events',
  });
  await executeTool({
    arguments: { includeLocations: false },
    callId: 'tomorrow',
    execution: 'client',
    name: 'get_tomorrow_calendar_events',
  });
  await executeTool({
    arguments: { includeLocations: false },
    callId: 'next',
    execution: 'client',
    name: 'get_next_calendar_event',
  });
  await executeTool({
    arguments: {
      endDateTime: '2026-08-12T00:00:00.000Z',
      includeLocations: false,
      startDateTime: '2026-08-11T00:00:00.000Z',
    },
    callId: 'range',
    execution: 'client',
    name: 'get_calendar_events_in_range',
  });

  assert.deepEqual(calls, [
    'today',
    'tomorrow',
    'next',
    ['range', '2026-08-11T00:00:00.000Z', '2026-08-12T00:00:00.000Z'],
  ]);
});

test('the native app can call the backend without a browser Origin header', async () => {
  const response = await handleAssistantRequest(nativeAssistantRequest(BASE_REQUEST), {
    allowedOrigin: ALLOWED_ORIGIN,
    apiKey: 'test-key',
    fetchImplementation: async () => successfulOpenAIResponse('Native reply'),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    content: 'Native reply',
    status: 'completed',
  });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('the backend verifies the bearer token before calling OpenAI', async () => {
  let verifiedToken;
  let providerCalled = false;
  const response = await handleUnauthenticatedAssistantRequest(
    assistantRequest(BASE_REQUEST),
    {
      allowedOrigin: ALLOWED_ORIGIN,
      apiKey: 'test-key',
      fetchImplementation: async () => {
        providerCalled = true;
        return successfulOpenAIResponse('Authenticated reply');
      },
      verifyAccessToken: async (accessToken) => {
        verifiedToken = accessToken;
        return { id: TEST_USER_ID };
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(verifiedToken, TEST_ACCESS_TOKEN);
  assert.equal(providerCalled, true);
});

test('missing and invalid bearer tokens are rejected safely', async () => {
  const missingTokenRequest = new Request(
    'https://assistant.example/api/assistant',
    {
      body: JSON.stringify(BASE_REQUEST),
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
      method: 'POST',
    },
  );
  const missingResponse = await handleUnauthenticatedAssistantRequest(
    missingTokenRequest,
    {
      allowedOrigin: ALLOWED_ORIGIN,
      apiKey: 'test-key',
      verifyAccessToken: verifyTestAccessToken,
    },
  );
  const invalidResponse = await handleUnauthenticatedAssistantRequest(
    assistantRequest(BASE_REQUEST, { Authorization: 'Bearer invalid-token' }),
    {
      allowedOrigin: ALLOWED_ORIGIN,
      apiKey: 'test-key',
      verifyAccessToken: verifyTestAccessToken,
    },
  );

  for (const response of [missingResponse, invalidResponse]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      code: 'authentication_required',
      error: 'Authentication is required.',
    });
  }
});

test('CORS preflight allows the Authorization header without requiring a token', async () => {
  const response = await handleUnauthenticatedAssistantRequest(
    new Request('https://assistant.example/api/assistant', {
      headers: { Origin: ALLOWED_ORIGIN },
      method: 'OPTIONS',
    }),
    { allowedOrigin: ALLOWED_ORIGIN },
  );

  assert.equal(response.status, 204);
  assert.match(
    response.headers.get('Access-Control-Allow-Headers') ?? '',
    /Authorization/,
  );
});

test('the assistant client rejects a missing session before making a request', async () => {
  let requestMade = false;
  const client = createUnauthenticatedAssistantApiClient(
    async () => {
      requestMade = true;
      return successfulOpenAIResponse();
    },
    undefined,
    async () => null,
  );

  await assert.rejects(
    client(BASE_REQUEST, new AbortController().signal),
    (error) =>
      error instanceof AssistantApiClientError &&
      error.code === 'authentication_required',
  );
  assert.equal(requestMade, false);
});

test('originless requests without the app client marker remain rejected', async () => {
  const response = await handleAssistantRequest(
    new Request('https://assistant.example/api/assistant', {
      body: JSON.stringify(BASE_REQUEST),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }),
    { allowedOrigin: ALLOWED_ORIGIN, apiKey: 'test-key' },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'invalid_request');
});

test('a wrong browser Origin cannot bypass the check with the app client marker', async () => {
  const response = await handleAssistantRequest(
    nativeAssistantRequest(BASE_REQUEST, { Origin: 'https://wrong.example' }),
    { allowedOrigin: ALLOWED_ORIGIN, apiKey: 'test-key' },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'invalid_request');
});

test('declared oversized bodies are rejected before the provider is called', async () => {
  let providerCalled = false;
  const response = await handleAssistantRequest(
    assistantRequest('{}', {
      'Content-Length': String(ASSISTANT_REQUEST_LIMITS.bodyBytes + 1),
    }),
    {
      allowedOrigin: ALLOWED_ORIGIN,
      apiKey: 'test-key',
      fetchImplementation: async () => {
        providerCalled = true;
        return successfulOpenAIResponse();
      },
    },
  );

  assert.equal(response.status, 413);
  assert.equal(providerCalled, false);
  assert.deepEqual(await response.json(), {
    code: 'request_too_large',
    error: 'The assistant request is too large.',
  });
});

test('streamed oversized bodies are rejected without a Content-Length header', async () => {
  const payload = new Uint8Array(ASSISTANT_REQUEST_LIMITS.bodyBytes + 1);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  const request = new Request('https://assistant.example/api/assistant', {
    body: stream,
    duplex: 'half',
    headers: {
      Authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      Origin: ALLOWED_ORIGIN,
    },
    method: 'POST',
  });
  const response = await handleAssistantRequest(request, {
    allowedOrigin: ALLOWED_ORIGIN,
    apiKey: 'test-key',
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'request_too_large');
});

test('conversation count, individual message, and total length limits are enforced', async () => {
  const invalidRequests = [
    {
      ...BASE_REQUEST,
      messages: Array.from({ length: ASSISTANT_REQUEST_LIMITS.messageCount + 1 }, () => ({
        content: 'Hello',
        role: 'user',
      })),
    },
    {
      ...BASE_REQUEST,
      messages: [
        { content: 'x'.repeat(ASSISTANT_REQUEST_LIMITS.messageLength + 1), role: 'user' },
      ],
    },
    {
      ...BASE_REQUEST,
      messages: Array.from({ length: 8 }, () => ({
        content: 'x'.repeat(ASSISTANT_REQUEST_LIMITS.messageLength),
        role: 'user',
      })),
    },
  ];

  for (const body of invalidRequests) {
    const response = await handleAssistantRequest(assistantRequest(body), {
      allowedOrigin: ALLOWED_ORIGIN,
      apiKey: 'test-key',
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'invalid_request');
  }
});

test('provider details remain in server logs and are not returned to the client', async () => {
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    const response = await handleAssistantRequest(assistantRequest(BASE_REQUEST), {
      allowedOrigin: ALLOWED_ORIGIN,
      apiKey: 'test-key',
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'invalid_api_key',
              message: 'Private provider detail sk-do-not-expose',
              type: 'authentication_error',
            },
          }),
          { status: 401 },
        ),
    });
    const responseText = await response.text();

    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(responseText), {
      code: 'assistant_unavailable',
      error: 'The assistant could not respond.',
    });
    assert.doesNotMatch(responseText, /invalid_api_key|authentication_error|sk-do-not-expose/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('the backend client converts a Vercel 429 into a safe application error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('Rate limited by the platform', { status: 429 });
  const client = createAssistantApiClient();

  try {
    await assert.rejects(
      client(BASE_REQUEST, new AbortController().signal),
      (error) =>
        error instanceof AssistantApiClientError &&
        error.code === 'rate_limited' &&
        error.message === 'Too many requests. Please wait a moment and try again.',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('clearing the assistant session changes its ID and does not retain old messages', async () => {
  const requests = [];
  const service = new AssistantService(async (request) => {
    requests.push(request);
    return 'Assistant response';
  });

  const first = await service.respond([{ content: 'Dentist at 3 PM.', role: 'user' }]);
  service.resetSession();
  const second = await service.respond([{ content: 'What is my appointment?', role: 'user' }]);

  assert.equal(first.status, 'success');
  assert.equal(second.status, 'success');
  assert.notEqual(first.sessionId, second.sessionId);
  assert.deepEqual(requests[1].messages, [
    { content: 'What is my appointment?', role: 'user' },
  ]);
});
