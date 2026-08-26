import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_CLIENT_HEADER,
  ASSISTANT_CLIENT_ID,
} from '../src/contracts/assistant/assistant-contract.ts';
import { handleAssistantRequest } from '../src/server/assistant/assistant-handler.ts';
import { createAssistantProjectToolExecutor } from '../src/server/assistant/project-tool-executor.ts';
import {
  PROJECT_DEFAULT_DISABLED_TOOLS,
  routeScopedProjectRequest,
} from '../src/server/assistant/project-scope-routing.ts';
import { InMemoryProjectRepository } from '../src/services/projects/in-memory-project-repository.ts';

const NOW = '2026-08-26T12:00:00.000Z';
const AQAL_ID = 'project-aqal';
const WORKOUT_ID = 'project-workout';

function project(id, name, description) {
  return {
    createdAt: NOW,
    description,
    id,
    name,
    priority: 'normal',
    status: 'active',
    timezone: 'America/Toronto',
    type: 'general',
    updatedAt: NOW,
  };
}

const projects = [
  project(AQAL_ID, 'AQAL Collective', 'A community and creative collective.'),
  project(WORKOUT_ID, 'Workout Planning', 'A personal training plan.'),
];

const seed = {
  decisions: [{
    createdAt: NOW,
    decidedAt: NOW,
    id: 'aqal-decision',
    projectId: AQAL_ID,
    statement: 'Build the collective around community practice.',
    status: 'active',
    updatedAt: NOW,
  }],
  projects,
  tasks: [{
    createdAt: NOW,
    id: 'aqal-task',
    position: 0,
    priority: 'normal',
    projectId: AQAL_ID,
    status: 'in_progress',
    title: 'Clarify the first public program',
    updatedAt: NOW,
  }],
  workSessions: [{
    createdAt: NOW,
    endedAt: NOW,
    id: 'aqal-session',
    projectId: AQAL_ID,
    startedAt: NOW,
    summary: 'Shaped the collective purpose and first program.',
    title: 'Purpose session',
    updatedAt: NOW,
  }],
};

function body(content, projectId = AQAL_ID, projectName = 'AQAL Collective') {
  return {
    context: {
      currentLocalDate: 'August 26, 2026',
      currentLocalTime: '8:00 AM',
      dayOfWeek: 'Wednesday',
      timezone: 'America/Toronto',
    },
    messages: [{ content, role: 'user' }],
    projectScope: { projectId, projectName },
    sessionId: `scope-${projectId}`,
  };
}

function nativeRequest(value) {
  return new Request('https://example.com/api/assistant', {
    body: JSON.stringify(value),
    headers: {
      [ASSISTANT_CLIENT_HEADER]: ASSISTANT_CLIENT_ID,
      Authorization: 'Bearer valid',
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
}

function projectExecutor(calls) {
  const execute = createAssistantProjectToolExecutor(
    () => new InMemoryProjectRepository(seed),
  );
  return async (call, context) => {
    calls.push(call);
    if (call.name !== 'get_project_context') {
      throw new Error(`Unexpected global tool: ${call.name}`);
    }
    return execute(call, context);
  };
}

test('ambiguous scoped work questions route to the selected Project with the smallest focus', () => {
  assert.equal(routeScopedProjectRequest(body('What are we working on?')).focus, 'comprehensive');
  assert.equal(routeScopedProjectRequest(body('What did we decide?')).focus, 'knowledge');
  assert.equal(routeScopedProjectRequest(body('What should I do next?')).focus, 'work');
  assert.equal(routeScopedProjectRequest(body('Where are we at?')).focus, 'comprehensive');
  assert.equal(routeScopedProjectRequest(body('What was I thinking about for this?')).focus, 'history');
});

test('explicit broader and unrelated intent escapes deterministic Project-default routing', () => {
  assert.equal(routeScopedProjectRequest(body('What other Projects do I have?')), null);
  assert.equal(routeScopedProjectRequest(body('What do I have going on overall?')), null);
  assert.equal(routeScopedProjectRequest(body('What should I eat tonight?')), null);
});

test('physical AQAL failure pattern preloads AQAL and makes global memory and Project listing unavailable', async () => {
  const executed = [];
  let providerCalls = 0;
  const response = await handleAssistantRequest(nativeRequest(body('What are we working on?')), {
    allowedOrigin: 'https://example.com',
    apiKey: 'test-key',
    executeServerTool: projectExecutor(executed),
    fetchImplementation: async (_url, init) => {
      providerCalls += 1;
      const requestBody = JSON.parse(String(init.body));
      const availableTools = requestBody.tools.map(({ name }) => name);
      for (const disabled of PROJECT_DEFAULT_DISABLED_TOOLS) {
        assert.equal(availableTools.includes(disabled), false, disabled);
      }
      const evidence = requestBody.input
        .filter((item) => item.type === 'function_call_output')
        .map((item) => item.output)
        .join(' ');
      assert.match(evidence, /AQAL Collective/);
      assert.match(evidence, /community and creative collective/);
      assert.doesNotMatch(evidence, /tofu|meal planning/i);
      assert.match(requestBody.instructions, /default semantic frame/);
      return new Response(JSON.stringify({ output: [{
        content: [{ text: 'We are shaping AQAL Collective and its first public program.', type: 'output_text' }],
        type: 'message',
      }] }), { headers: { 'Content-Type': 'application/json' } });
    },
    verifyAccessToken: async () => ({ id: 'owner-a' }),
  });
  assert.equal(providerCalls, 1);
  assert.deepEqual(executed.map((call) => [call.name, call.arguments.projectId, call.arguments.focus]), [
    ['get_project_context', AQAL_ID, 'comprehensive'],
  ]);
  assert.deepEqual(await response.json(), {
    content: 'We are shaping AQAL Collective and its first public program.',
    status: 'completed',
  });
});

test('explicit broader and unrelated questions retain the normal global tool set', async () => {
  for (const question of ['What other Projects do I have?', 'What should I eat tonight?']) {
    let executed = 0;
    const response = await handleAssistantRequest(nativeRequest(body(question)), {
      allowedOrigin: 'https://example.com',
      apiKey: 'test-key',
      executeServerTool: async () => { executed += 1; throw new Error('No preload expected'); },
      fetchImplementation: async (_url, init) => {
        const availableTools = JSON.parse(String(init.body)).tools.map(({ name }) => name);
        assert.equal(availableTools.includes('list_projects'), true);
        assert.equal(availableTools.includes('search_general_memory'), true);
        return new Response(JSON.stringify({ output: [{
          content: [{ text: 'Broader intent remains available.', type: 'output_text' }],
          type: 'message',
        }] }), { headers: { 'Content-Type': 'application/json' } });
      },
      verifyAccessToken: async () => ({ id: 'owner-a' }),
    });
    assert.equal(response.status, 200);
    assert.equal(executed, 0);
  }
});

test('switching AQAL to Workout Planning and back verifies each request without stale scope', async () => {
  const seen = [];
  for (const scope of [
    [AQAL_ID, 'AQAL Collective'],
    [WORKOUT_ID, 'Workout Planning'],
    [AQAL_ID, 'AQAL Collective'],
  ]) {
    const response = await handleAssistantRequest(
      nativeRequest(body('What are we working on?', scope[0], scope[1])),
      {
        allowedOrigin: 'https://example.com',
        apiKey: 'test-key',
        executeServerTool: projectExecutor(seen),
        fetchImplementation: async (_url, init) => {
          const evidence = JSON.parse(String(init.body)).input
            .filter((item) => item.type === 'function_call_output')
            .map((item) => item.output).join(' ');
          assert.match(evidence, new RegExp(scope[1]));
          return new Response(JSON.stringify({ output: [{
            content: [{ text: scope[1], type: 'output_text' }], type: 'message',
          }] }), { headers: { 'Content-Type': 'application/json' } });
        },
        verifyAccessToken: async () => ({ id: 'owner-a' }),
      },
    );
    assert.deepEqual(await response.json(), { content: scope[1], status: 'completed' });
  }
  assert.deepEqual(seen.map((call) => call.arguments.projectId), [AQAL_ID, WORKOUT_ID, AQAL_ID]);
});

test('a mismatched Project name is rejected before model execution', async () => {
  let providerCalls = 0;
  const response = await handleAssistantRequest(
    nativeRequest(body('Where are we at?', AQAL_ID, 'Workout Planning')),
    {
      allowedOrigin: 'https://example.com',
      apiKey: 'test-key',
      executeServerTool: projectExecutor([]),
      fetchImplementation: async () => { providerCalls += 1; throw new Error('not reached'); },
      verifyAccessToken: async () => ({ id: 'owner-a' }),
    },
  );
  assert.equal(response.status, 400);
  assert.equal(providerCalls, 0);
});
