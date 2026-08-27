import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAssistantRequest } from '../src/server/assistant/assistant-handler.ts';
import { createAssistantProjectToolExecutor } from '../src/server/assistant/project-tool-executor.ts';
import { InvalidAccessTokenError } from '../src/server/auth/supabase-token-verifier.ts';
import { InMemoryProjectRepository } from '../src/services/projects/in-memory-project-repository.ts';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';
const ACCESS_TOKEN = 'verified-project-token';
const PROJECT_ID = 'project-aqal';
const CREATED_AT = '2026-08-12T12:00:00.000Z';
const UPDATED_AT = '2026-08-13T12:00:00.000Z';
const BASE_REQUEST = {
  context: {
    currentLocalDate: 'August 13, 2026',
    currentLocalTime: '10:00:00 AM',
    dayOfWeek: 'Thursday',
    timezone: 'America/Toronto',
  },
  messages: [{ content: 'Where am I with AQAL Collective?', role: 'user' }],
  sessionId: 'assistant-project-test',
};

function project(overrides = {}) {
  return {
    createdAt: CREATED_AT,
    description: 'Create the AQAL Collective website.',
    goal: 'Launch a clear public presence.',
    id: PROJECT_ID,
    name: 'AQAL Collective',
    priority: 'high',
    status: 'active',
    targetDate: '2026-09-01',
    timezone: 'America/Toronto',
    type: 'website',
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function seed() {
  return {
    changeEvents: [{
      entityId: 'task-complete', entityType: 'task', eventType: 'task_completed',
      id: 'change-1', occurredAt: UPDATED_AT, projectId: PROJECT_ID,
      summary: 'Completed initial sitemap.',
    }],
    decisions: [
      { createdAt: CREATED_AT, decidedAt: CREATED_AT, id: 'decision-current',
        projectId: PROJECT_ID, rationale: 'Matches the identity.',
        statement: 'Use indigo and warm cream.', status: 'active', updatedAt: UPDATED_AT },
      { createdAt: CREATED_AT, decidedAt: CREATED_AT, id: 'decision-old',
        projectId: PROJECT_ID, statement: 'Use bright red.', status: 'superseded',
        updatedAt: UPDATED_AT },
    ],
    deliverables: [{ createdAt: CREATED_AT, dueDate: '2026-08-20', id: 'deliverable-1',
      milestoneId: 'milestone-1', name: 'Homepage draft', position: 0,
      projectId: PROJECT_ID, status: 'in_progress', updatedAt: UPDATED_AT }],
    knowledgeItems: [
      { content: 'The audience is community organizers.', createdAt: CREATED_AT,
        id: 'knowledge-current', kind: 'fact', projectId: PROJECT_ID,
        status: 'current', updatedAt: UPDATED_AT },
      { content: 'The audience is enterprise buyers.', createdAt: CREATED_AT,
        id: 'knowledge-old', kind: 'fact', projectId: PROJECT_ID,
        status: 'superseded', updatedAt: UPDATED_AT },
      { content: 'Should the homepage include member profiles?', createdAt: CREATED_AT,
        id: 'question-current', kind: 'question', projectId: PROJECT_ID,
        status: 'current', updatedAt: UPDATED_AT },
      { content: 'Old resolved question', createdAt: CREATED_AT,
        id: 'question-resolved', kind: 'question', projectId: PROJECT_ID,
        status: 'resolved', updatedAt: UPDATED_AT },
    ],
    milestones: [{ createdAt: CREATED_AT, id: 'milestone-1', name: 'Design',
      position: 0, projectId: PROJECT_ID, status: 'active', updatedAt: UPDATED_AT }],
    projects: [project()],
    resources: [{ createdAt: CREATED_AT, externalUrl: 'https://example.com/brand',
      id: 'resource-1', name: 'Brand reference', projectId: PROJECT_ID,
      role: 'reference', type: 'link', updatedAt: UPDATED_AT },
    { byteSize: 4, createdAt: CREATED_AT, id: 'asset-1', mimeType: 'image/png',
      name: 'Linen swatch', originalFilename: 'linen.png', projectId: PROJECT_ID,
      role: 'reference', sectionId: 'materials', status: 'current',
      storagePath: `${USER_ID}/${PROJECT_ID}/asset-1/object-1`, type: 'image',
      updatedAt: UPDATED_AT }],
    sections: [{ createdAt: CREATED_AT, id: 'materials', isDefault: false, position: 1,
      projectId: PROJECT_ID, status: 'active', title: 'Materials', updatedAt: UPDATED_AT }],
    tasks: [
      { createdAt: CREATED_AT, id: 'task-open', position: 0, priority: 'high',
        projectId: PROJECT_ID, status: 'in_progress', title: 'Finish homepage copy',
        updatedAt: UPDATED_AT },
      { completedAt: UPDATED_AT, createdAt: CREATED_AT, id: 'task-complete',
        position: 1, priority: 'normal', projectId: PROJECT_ID, status: 'completed',
        title: 'Create sitemap', updatedAt: UPDATED_AT },
    ],
    workSessionEntries: [{ content: 'Private raw transcript text', id: 'entry-1',
      kind: 'user_message', occurredAt: UPDATED_AT, position: 0, sessionId: 'session-1' }],
    workSessions: [{ createdAt: CREATED_AT, endedAt: UPDATED_AT, id: 'session-1',
      projectId: PROJECT_ID, startedAt: CREATED_AT, summary: 'Reviewed visual direction.',
      title: 'Design review', updatedAt: UPDATED_AT }],
  };
}

function call(name, args, callId = 'project-call-1') {
  return { arguments: args, callId, execution: 'server', name };
}

function executorFor(seedByUser = { [USER_ID]: seed() }, contexts = []) {
  return createAssistantProjectToolExecutor((context) => {
    contexts.push(context);
    return new InMemoryProjectRepository(seedByUser[context.userId] ?? {});
  });
}

test('list_projects returns only the verified owner’s bounded Project identities', async () => {
  const contexts = [];
  const execute = executorFor(undefined, contexts);
  const output = await execute(
    call('list_projects', { includeArchived: false }),
    { accessToken: ACCESS_TOKEN, userId: USER_ID },
  );

  assert.deepEqual(contexts, [{ accessToken: ACCESS_TOKEN, userId: USER_ID }]);
  assert.equal(output.result.status, 'success');
  assert.deepEqual(output.result.projects.map((value) => value.name), ['AQAL Collective']);
  assert.equal(output.result.projects[0].status, 'active');
  assert.equal(JSON.stringify(output).includes(ACCESS_TOKEN), false);

  const otherOutput = await execute(
    call('list_projects', { includeArchived: false }, 'other-call'),
    { accessToken: 'other-token', userId: OTHER_USER_ID },
  );
  assert.deepEqual(otherOutput.result.projects, []);
});

test('comprehensive Project context returns current facts without raw transcripts', async () => {
  let rawEntryReads = 0;
  const execute = createAssistantProjectToolExecutor(() => {
    const repository = new InMemoryProjectRepository(seed());
    repository.listWorkSessionEntries = async () => {
      rawEntryReads += 1;
      throw new Error('Raw entries must not be queried.');
    };
    return repository;
  });
  const output = await execute(
    call('get_project_context', { focus: 'comprehensive', projectId: PROJECT_ID }),
    { accessToken: ACCESS_TOKEN, userId: USER_ID },
  );

  assert.equal(output.result.status, 'success');
  assert.deepEqual(output.result.openTasks.map((value) => value.id), ['task-open']);
  assert.deepEqual(output.result.currentKnowledge.map((value) => value.id), ['knowledge-current']);
  assert.deepEqual(output.result.currentDecisions.map((value) => value.id), ['decision-current']);
  assert.deepEqual(output.result.unresolvedQuestions.map((value) => value.id), ['question-current']);
  assert.equal(output.result.recentWorkSessions[0].summary, 'Reviewed visual direction.');
  assert.equal(output.result.resources[0].name, 'Brand reference');
  assert.deepEqual(output.result.resources[1], {
    byteSize: 4, createdAt: CREATED_AT, id: 'asset-1', mimeType: 'image/png',
    name: 'Linen swatch', originalFilename: 'linen.png', role: 'reference',
    sectionId: 'materials', sectionTitle: 'Materials', status: 'current', type: 'image',
  });
  assert.equal(output.result.recentChanges[0].eventType, 'task_completed');
  assert.equal(rawEntryReads, 0);
  assert.doesNotMatch(JSON.stringify(output), /Private raw transcript text|knowledge-old|decision-old/);
});

test('Project context returns the newly completed work session as the most recent session', async () => {
  const projectSeed = seed();
  projectSeed.workSessions.push({
    createdAt: '2026-08-21T07:19:51.817Z',
    endedAt: '2026-08-21T07:19:51.817Z',
    id: 'session-newest',
    projectId: PROJECT_ID,
    startedAt: '2026-08-21T07:18:06.218Z',
    summary: 'Compared smaller manufacturer minimum-order options.',
    title: 'Manufacturer minimums',
    updatedAt: '2026-08-21T07:19:51.817Z',
  });
  const execute = executorFor({ [USER_ID]: projectSeed });
  const output = await execute(
    call('get_project_context', { focus: 'history', projectId: PROJECT_ID }),
    { accessToken: ACCESS_TOKEN, userId: USER_ID },
  );

  assert.equal(output.result.status, 'success');
  assert.equal(output.result.recentWorkSessions[0].id, 'session-newest');
  assert.equal(
    output.result.recentWorkSessions[0].summary,
    'Compared smaller manufacturer minimum-order options.',
  );
});

test('Project context bounds large sections and reports truncation', async () => {
  const manyTasks = Array.from({ length: 24 }, (_, index) => ({
    createdAt: CREATED_AT, id: `task-${index}`, position: index, priority: 'normal',
    projectId: PROJECT_ID, status: 'todo', title: `Task ${index}`, updatedAt: UPDATED_AT,
  }));
  const execute = executorFor({ [USER_ID]: { projects: [project()], tasks: manyTasks } });
  const output = await execute(
    call('get_project_context', { focus: 'work', projectId: PROJECT_ID }),
    { accessToken: ACCESS_TOKEN, userId: USER_ID },
  );

  assert.equal(output.result.openTasks.length, 20);
  assert.ok(output.result.truncatedSections.includes('openTasks'));
});

function openAIResponse(output) {
  return new Response(JSON.stringify({ output }), {
    headers: { 'Content-Type': 'application/json', 'x-request-id': 'project-test' },
  });
}

function projectToolResponse(name, args, callId) {
  return openAIResponse([{ arguments: JSON.stringify(args), call_id: callId, name,
    type: 'function_call' }]);
}

function assistantRequest(body, token = ACCESS_TOKEN) {
  return new Request('https://assistant.example/api/assistant', {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Origin: 'https://example.com' },
    method: 'POST',
  });
}

async function verifyToken(token) {
  if (token !== ACCESS_TOKEN) throw new InvalidAccessTokenError();
  return { id: USER_ID };
}

test('server tool loop can list then retrieve a Project before Tina answers', async () => {
  const requests = [];
  const contexts = [];
  const responses = [
    projectToolResponse('list_projects', { includeArchived: false }, 'list-call'),
    projectToolResponse('get_project_context', { focus: 'work', projectId: PROJECT_ID }, 'detail-call'),
    openAIResponse([{ content: [{ text: 'Finish the homepage copy next.', type: 'output_text' }],
      type: 'message' }]),
  ];
  const response = await handleAssistantRequest(assistantRequest(BASE_REQUEST), {
    allowedOrigin: 'https://example.com', apiKey: 'test-key',
    executeServerTool: executorFor(undefined, contexts),
    fetchImplementation: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      return responses.shift();
    },
    verifyAccessToken: verifyToken,
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, 'Finish the homepage copy next.');
  assert.deepEqual(contexts, [
    { accessToken: ACCESS_TOKEN, userId: USER_ID },
    { accessToken: ACCESS_TOKEN, userId: USER_ID },
  ]);
  assert.equal(requests.length, 3);
  assert.match(requests[1].input.at(-1).output, /AQAL Collective/);
  assert.match(requests[2].input.at(-1).output, /Finish homepage copy/);
  assert.doesNotMatch(JSON.stringify(requests), /Private raw transcript text|verified-project-token/);
});

test('suggestive uploaded filename remains metadata, not evidence of document contents', async () => {
  const assetSeed = seed();
  assetSeed.resources = [{
    byteSize: 842_731,
    createdAt: CREATED_AT,
    id: 'asset-manufacturer-contract',
    mimeType: 'application/pdf',
    name: 'Final manufacturer pricing and contract',
    originalFilename: 'final-manufacturer-pricing-and-contract.pdf',
    projectId: PROJECT_ID,
    resourceKind: 'uploaded_asset',
    role: 'reference',
    sectionId: 'materials',
    sourceMetadata: { addedAt: CREATED_AT, kind: 'original-upload', picker: 'document-picker' },
    status: 'current',
    storagePath: `${USER_ID}/${PROJECT_ID}/asset-manufacturer-contract/object-contract`,
    type: 'pdf',
    updatedAt: UPDATED_AT,
  }];
  const requests = [];
  const executeReadTool = executorFor({ [USER_ID]: assetSeed });
  const safeAnswer = 'A PDF named final-manufacturer-pricing-and-contract.pdf exists in the Materials section, but its contents have not been made available for me to read or analyze, so I cannot tell what price the manufacturer quoted.';
  let providerStep = 0;
  const response = await handleAssistantRequest(assistantRequest({
    ...BASE_REQUEST,
    messages: [{ content: 'What price did the manufacturer quote in that document?', role: 'user' }],
  }), {
    allowedOrigin: 'https://example.com',
    apiKey: 'test-key',
    executeServerTool: executeReadTool,
    fetchImplementation: async (_url, init) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      if (providerStep++ === 0) {
        return projectToolResponse('get_project_context', {
          focus: 'knowledge', projectId: PROJECT_ID,
        }, 'asset-context');
      }
      const toolResult = JSON.parse(request.input.at(-1).output);
      assert.equal(toolResult.resources[0].originalFilename,
        'final-manufacturer-pricing-and-contract.pdf');
      assert.equal(toolResult.resources[0].mimeType, 'application/pdf');
      assert.equal(toolResult.resources[0].byteSize, 842_731);
      assert.equal(toolResult.resources[0].sectionTitle, 'Materials');
      assert.equal('content' in toolResult.resources[0], false);
      assert.equal('summary' in toolResult.resources[0], false);
      assert.equal('sourceMetadata' in toolResult.resources[0], false);
      assert.match(request.instructions, /not evidence of the file contents/i);
      return openAIResponse([{ content: [{ text: safeAnswer, type: 'output_text' }],
        type: 'message' }]);
    },
    verifyAccessToken: verifyToken,
  });

  assert.equal(response.status, 200);
  const content = (await response.json()).content;
  assert.equal(content, safeAnswer);
  assert.match(content, /PDF named final-manufacturer-pricing-and-contract\.pdf exists/);
  assert.match(content, /contents have not been made available.*read or analyze/i);
  assert.doesNotMatch(content, /I (?:read|analyzed|reviewed|inspected) (?:the|that) (?:file|document)/i);
  assert.doesNotMatch(content, /[$€£]\s*\d|\b\d+(?:\.\d+)?\s*(?:USD|CAD|EUR|GBP)\b/i);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].input.at(-2).name, 'get_project_context');
  assert.equal(requests[1].input.at(-1).type, 'function_call_output');
});

test('a descriptive clothing-brand reference resolves one clear Project before answering', async () => {
  const clothingSeed = seed();
  clothingSeed.projects = [project({
    description: 'Build AQAL Collective as a linen clothing brand.',
    goal: 'Launch the first clothing collection.',
    type: 'business',
  })];
  clothingSeed.decisions = [{
    createdAt: CREATED_AT,
    decidedAt: CREATED_AT,
    id: 'decision-linen',
    projectId: PROJECT_ID,
    statement: 'Use linen for the first collection.',
    status: 'active',
    updatedAt: UPDATED_AT,
  }];
  const requests = [];
  const executedNames = [];
  const executeReadTool = executorFor({ [USER_ID]: clothingSeed });
  const responses = [
    projectToolResponse('list_projects', { includeArchived: false }, 'list-clothing'),
    projectToolResponse('get_project_context', { focus: 'knowledge', projectId: PROJECT_ID }, 'context-clothing'),
    openAIResponse([{ content: [{
      text: 'AQAL? I like the direction it is taking. Linen gives the first collection a clear identity.',
      type: 'output_text',
    }], type: 'message' }]),
  ];
  const response = await handleAssistantRequest(assistantRequest({
    ...BASE_REQUEST,
    messages: [{ content: 'What do you think of the clothing brand I am working on?', role: 'user' }],
  }), {
    allowedOrigin: 'https://example.com',
    apiKey: 'test-key',
    executeServerTool: async (toolCall, context) => {
      executedNames.push(toolCall.name);
      return executeReadTool(toolCall, context);
    },
    fetchImplementation: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      return responses.shift();
    },
    verifyAccessToken: verifyToken,
  });

  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).content,
    'AQAL? I like the direction it is taking. Linen gives the first collection a clear identity.',
  );
  assert.deepEqual(executedNames, ['list_projects', 'get_project_context']);
  assert.match(requests[1].input.at(-1).output, /linen clothing brand/);
  assert.match(requests[2].input.at(-1).output, /Use linen for the first collection/);
  assert.equal(executedNames.some((name) =>
    ['create_project', 'update_project', 'manage_project_work', 'record_project_truth'].includes(name)), false);
});

test('an ambiguous descriptive reference stops after bounded identities and asks naturally', async () => {
  const ambiguousSeed = {
    projects: [
      project({ description: 'Develop the AQAL clothing brand.', type: 'business' }),
      project({
        description: 'Explore a second independent clothing label.',
        id: 'project-second-label',
        name: 'Second Label',
        type: 'business',
        updatedAt: '2026-08-14T12:00:00.000Z',
      }),
    ],
  };
  const executedNames = [];
  const requests = [];
  const executeReadTool = executorFor({ [USER_ID]: ambiguousSeed });
  const responses = [
    projectToolResponse('list_projects', { includeArchived: false }, 'list-ambiguous'),
    openAIResponse([{ content: [{
      text: 'Do you mean AQAL Collective or Second Label?',
      type: 'output_text',
    }], type: 'message' }]),
  ];
  const response = await handleAssistantRequest(assistantRequest({
    ...BASE_REQUEST,
    messages: [{ content: 'What do you think of the clothing brand I am working on?', role: 'user' }],
  }), {
    allowedOrigin: 'https://example.com',
    apiKey: 'test-key',
    executeServerTool: async (toolCall, context) => {
      executedNames.push(toolCall.name);
      return executeReadTool(toolCall, context);
    },
    fetchImplementation: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      return responses.shift();
    },
    verifyAccessToken: verifyToken,
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, 'Do you mean AQAL Collective or Second Label?');
  assert.deepEqual(executedNames, ['list_projects']);
  assert.match(requests[1].input.at(-1).output, /AQAL Collective/);
  assert.match(requests[1].input.at(-1).output, /Second Label/);
});

test('unrelated completed answers do not execute Project tools', async () => {
  let executions = 0;
  const response = await handleAssistantRequest(assistantRequest({
    ...BASE_REQUEST,
    messages: [{ content: 'Explain photosynthesis.', role: 'user' }],
  }), {
    allowedOrigin: 'https://example.com', apiKey: 'test-key',
    executeServerTool: async () => { executions += 1; throw new Error('unexpected'); },
    fetchImplementation: async () => openAIResponse([{ content: [{ text: 'Plants convert light into chemical energy.', type: 'output_text' }], type: 'message' }]),
    verifyAccessToken: verifyToken,
  });

  assert.equal(response.status, 200);
  assert.equal(executions, 0);
});

test('one assistant step can combine server Project data with a client Calendar request', async () => {
  const response = await handleAssistantRequest(assistantRequest({
    ...BASE_REQUEST,
    messages: [{ content: 'What should I work on today?', role: 'user' }],
  }), {
    allowedOrigin: 'https://example.com', apiKey: 'test-key',
    executeServerTool: executorFor(),
    fetchImplementation: async () => openAIResponse([
      { arguments: JSON.stringify({ focus: 'work', projectId: PROJECT_ID }),
        call_id: 'project-detail', name: 'get_project_context', type: 'function_call' },
      { arguments: JSON.stringify({ includeLocations: false }),
        call_id: 'calendar-today', name: 'get_today_calendar_events', type: 'function_call' },
    ]),
    verifyAccessToken: verifyToken,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, 'requires_client_tools');
  assert.deepEqual(body.pendingToolStep.calls.map((value) => [value.name, value.execution]), [
    ['get_project_context', 'server'],
    ['get_today_calendar_events', 'client'],
  ]);
  assert.deepEqual(body.pendingToolStep.outputs.map((value) => value.name), [
    'get_project_context',
  ]);
});

test('invalid authentication rejects a Project request before tool execution', async () => {
  let executions = 0;
  let providerCalls = 0;
  const response = await handleAssistantRequest(assistantRequest(BASE_REQUEST, 'invalid-token'), {
    allowedOrigin: 'https://example.com', apiKey: 'test-key',
    executeServerTool: async () => { executions += 1; throw new Error('unexpected'); },
    fetchImplementation: async () => { providerCalls += 1; return projectToolResponse('list_projects', { includeArchived: false }, 'list-call'); },
    verifyAccessToken: verifyToken,
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'authentication_required');
  assert.equal(executions, 0);
  assert.equal(providerCalls, 0);
});
