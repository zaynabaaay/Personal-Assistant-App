import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_REQUEST_LIMITS,
  handleAssistantRequest,
} from '../api/assistant.ts';
import {
  AssistantApiClientError,
  assistantApiClient,
} from '../src/services/assistant/assistant-api-client.ts';
import { AssistantService } from '../src/services/assistant/assistant-service.ts';

const ALLOWED_ORIGIN = 'https://example.com';
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

function assistantRequest(body, headers = {}) {
  return new Request('https://assistant.example/api/assistant', {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
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
  assert.deepEqual(await response.json(), { content: 'Assistant reply' });
  assert.deepEqual(openAIRequest.input, BASE_REQUEST.messages);
  assert.equal(openAIRequest.store, false);
  assert.match(openAIRequest.instructions, /America\/Toronto/);
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
    headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
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

  try {
    await assert.rejects(
      assistantApiClient(BASE_REQUEST, new AbortController().signal),
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
