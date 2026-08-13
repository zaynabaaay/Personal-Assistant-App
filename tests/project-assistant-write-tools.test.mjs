import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAssistantRequest } from '../src/server/assistant/assistant-handler.ts';
import { createAssistantProjectToolExecutor } from '../src/server/assistant/project-tool-executor.ts';
import { createAssistantProjectWriteToolExecutor } from '../src/server/assistant/project-write-tool-executor.ts';
import { InvalidAccessTokenError } from '../src/server/auth/supabase-token-verifier.ts';
import { InMemoryProjectRepository } from '../src/services/projects/in-memory-project-repository.ts';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';
const TOKEN = 'verified-write-token';
const PROJECT_ID = 'project-aqal';
const NOW = '2026-08-13T16:00:00.000Z';

function project(overrides = {}) {
  return { createdAt: NOW, id: PROJECT_ID, name: 'AQAL Collective', priority: 'high',
    status: 'active', timezone: 'America/Toronto', type: 'business', updatedAt: NOW,
    ...overrides };
}

function toolCall(name, args, callId = `${name}-call`) {
  return { arguments: args, callId, execution: 'server', name };
}

function createArgs(overrides = {}) {
  return { description: null, goal: null, name: 'AQAL Collective', priority: 'normal',
    startDate: null, status: 'active', targetDate: null, timezone: 'America/Toronto',
    type: 'business', ...overrides };
}

function projectUpdateArgs(overrides = {}) {
  return { description: null, goal: null, name: null, priority: null, projectId: PROJECT_ID,
    startDate: null, status: null, targetDate: null, type: null, ...overrides };
}

function workArgs(operation, overrides = {}) {
  return { description: null, dueDate: null, entityId: null, milestoneId: null, name: null,
    operation, priority: null, projectId: PROJECT_ID, status: null, targetDate: null,
    ...overrides };
}

function truthArgs(operation, overrides = {}) {
  return { confirmation: 'explicit', content: null, entityId: null, kind: null, operation,
    projectId: PROJECT_ID, rationale: null, statement: null, title: null, ...overrides };
}

function executor(repository) {
  return createAssistantProjectWriteToolExecutor(() => repository);
}

test('creates a Project and suppresses an obvious duplicate name', async () => {
  const repository = new InMemoryProjectRepository();
  const execute = executor(repository);
  const first = await execute(toolCall('create_project', createArgs()), { accessToken: TOKEN, userId: USER_ID });
  const second = await execute(toolCall('create_project', createArgs({ name: '  aqal   collective ' }), 'duplicate'), { accessToken: TOKEN, userId: USER_ID });

  assert.equal(first.result.outcome, 'created');
  assert.equal(second.result.outcome, 'unchanged');
  assert.equal((await repository.listProjects()).length, 1);
});

test('updates Project fields and creates tasks, milestones, and deliverables without duplicates', async () => {
  const repository = new InMemoryProjectRepository({ projects: [project()] });
  const execute = executor(repository);
  const deadline = await execute(toolCall('update_project', projectUpdateArgs({ targetDate: '2026-09-15' })), { accessToken: TOKEN, userId: USER_ID });
  const task = await execute(toolCall('manage_project_work', workArgs('create_task', { name: 'Reach out to manufacturers', priority: 'high' })), { accessToken: TOKEN, userId: USER_ID });
  const duplicateTask = await execute(toolCall('manage_project_work', workArgs('create_task', { name: ' reach OUT  to manufacturers ' }), 'duplicate-task'), { accessToken: TOKEN, userId: USER_ID });
  const milestone = await execute(toolCall('manage_project_work', workArgs('create_milestone', { name: 'Samples', targetDate: '2026-09-15' })), { accessToken: TOKEN, userId: USER_ID });
  const deliverable = await execute(toolCall('manage_project_work', workArgs('create_deliverable', { dueDate: '2026-09-15', milestoneId: milestone.result.entity.id, name: 'Approved sample' })), { accessToken: TOKEN, userId: USER_ID });

  assert.equal(deadline.result.outcome, 'updated');
  assert.equal((await repository.getProject(PROJECT_ID)).targetDate, '2026-09-15');
  assert.equal(task.result.outcome, 'created');
  assert.equal(duplicateTask.result.outcome, 'unchanged');
  assert.equal((await repository.listTasks(PROJECT_ID)).length, 1);
  assert.equal((await repository.getDeliverable(deliverable.result.entity.id)).milestoneId, milestone.result.entity.id);
});

test('completes an unambiguous task with its meaningful history atomically', async () => {
  const repository = new InMemoryProjectRepository({ projects: [project()], tasks: [{
    createdAt: NOW, id: 'task-email', position: 0, priority: 'normal', projectId: PROJECT_ID,
    status: 'todo', title: 'Send manufacturer email', updatedAt: NOW,
  }] });
  let atomicWrites = 0;
  const original = repository.saveAtomically.bind(repository);
  repository.saveAtomically = async (changes) => { atomicWrites += 1; await original(changes); };
  const output = await executor(repository)(toolCall('manage_project_work', workArgs('complete_task', { entityId: 'task-email' })), { accessToken: TOKEN, userId: USER_ID });

  assert.equal(output.result.outcome, 'updated');
  assert.equal((await repository.getTask('task-email')).status, 'completed');
  assert.equal((await repository.listChangeEvents(PROJECT_ID))[0].eventType, 'task_completed');
  assert.equal(atomicWrites, 1);
});

test('adds accepted knowledge, unresolved questions, and confirmed decisions without duplicates', async () => {
  const repository = new InMemoryProjectRepository({ projects: [project()] });
  const execute = executor(repository);
  const knowledge = await execute(toolCall('record_project_truth', truthArgs('add_knowledge', { content: 'First collection uses linen.', kind: 'fact' })), { accessToken: TOKEN, userId: USER_ID });
  const duplicate = await execute(toolCall('record_project_truth', truthArgs('add_knowledge', { content: ' first collection  uses linen. ', kind: 'fact' }), 'duplicate-knowledge'), { accessToken: TOKEN, userId: USER_ID });
  const question = await execute(toolCall('record_project_truth', truthArgs('add_question', { content: 'Which manufacturer has the best lead time?' })), { accessToken: TOKEN, userId: USER_ID });
  const decision = await execute(toolCall('record_project_truth', truthArgs('add_decision', { statement: 'Focus on linen for the first collection.' })), { accessToken: TOKEN, userId: USER_ID });

  assert.equal(knowledge.result.outcome, 'created');
  assert.equal(duplicate.result.outcome, 'unchanged');
  assert.equal(question.result.entity.kind, 'question');
  assert.equal(decision.result.entity.kind, 'decision');
  assert.equal((await repository.listKnowledgeItems(PROJECT_ID)).length, 2);
  assert.equal((await repository.listDecisions(PROJECT_ID)).length, 1);
  assert.equal((await repository.listChangeEvents(PROJECT_ID)).filter((event) => event.eventType === 'knowledge_accepted').length, 2);
});

test('replacement requires confirmation and preserves superseded knowledge and decisions', async () => {
  const repository = new InMemoryProjectRepository({
    projects: [project()],
    knowledgeItems: [{ content: 'The launch color is indigo.', createdAt: NOW, id: 'knowledge-color', kind: 'fact', projectId: PROJECT_ID, status: 'current', updatedAt: NOW }],
    decisions: [{ createdAt: NOW, decidedAt: NOW, id: 'decision-color', projectId: PROJECT_ID, statement: 'Use indigo.', status: 'active', updatedAt: NOW }],
  });
  const execute = executor(repository);
  const blocked = await execute(toolCall('record_project_truth', truthArgs('replace_decision', { entityId: 'decision-color', statement: 'Use burgundy.' })), { accessToken: TOKEN, userId: USER_ID });
  assert.equal(blocked.result.status, 'confirmation_required');
  assert.equal((await repository.listDecisions(PROJECT_ID)).length, 1);

  const decision = await execute(toolCall('record_project_truth', truthArgs('replace_decision', { confirmation: 'confirmed_replacement', entityId: 'decision-color', statement: 'Use burgundy.' }), 'confirmed-decision'), { accessToken: TOKEN, userId: USER_ID });
  const knowledge = await execute(toolCall('record_project_truth', truthArgs('replace_knowledge', { confirmation: 'confirmed_replacement', content: 'The launch color is burgundy.', entityId: 'knowledge-color', kind: 'fact' }), 'confirmed-knowledge'), { accessToken: TOKEN, userId: USER_ID });

  assert.equal(decision.result.outcome, 'updated');
  assert.equal(knowledge.result.outcome, 'updated');
  const decisions = await repository.listDecisions(PROJECT_ID);
  const items = await repository.listKnowledgeItems(PROJECT_ID);
  assert.equal(decisions.find((value) => value.id === 'decision-color').status, 'superseded');
  assert.equal(decisions.find((value) => value.supersedesDecisionId === 'decision-color').status, 'active');
  assert.equal(items.find((value) => value.id === 'knowledge-color').status, 'superseded');
  assert.equal(items.find((value) => value.supersedesKnowledgeItemId === 'knowledge-color').status, 'current');
  assert.deepEqual((await repository.listChangeEvents(PROJECT_ID)).map((event) => event.eventType).sort(), ['decision_superseded', 'knowledge_superseded']);
});

test('ambiguous contextual references request clarification and make no write', async () => {
  const repository = new InMemoryProjectRepository({ projects: [project()], tasks: [{ createdAt: NOW,
    id: 'task-a', position: 0, priority: 'normal', projectId: PROJECT_ID, status: 'todo', title: 'One', updatedAt: NOW }] });
  const output = await executor(repository)(toolCall('manage_project_work', workArgs('complete_task', { entityId: null })), { accessToken: TOKEN, userId: USER_ID });
  assert.equal(output.result.status, 'clarification_required');
  assert.equal((await repository.getTask('task-a')).status, 'todo');
});

test('verified user context isolates writes across owners', async () => {
  const ownerRepository = new InMemoryProjectRepository({ projects: [project()] });
  const otherRepository = new InMemoryProjectRepository();
  const execute = createAssistantProjectWriteToolExecutor((context) => context.userId === USER_ID ? ownerRepository : otherRepository);
  const output = await execute(toolCall('update_project', projectUpdateArgs({ targetDate: '2026-09-15' })), { accessToken: 'other-token', userId: OTHER_USER_ID });

  assert.equal(output.result.status, 'not_found');
  assert.equal((await ownerRepository.getProject(PROJECT_ID)).targetDate, undefined);
  assert.equal((await otherRepository.listProjects()).length, 0);
});

function openAIResponse(output) {
  return new Response(JSON.stringify({ output }), { headers: { 'Content-Type': 'application/json' } });
}

function request(message, token = TOKEN) {
  return new Request('https://example.com/api/assistant', { body: JSON.stringify({ context: {
    currentLocalDate: 'August 13, 2026', currentLocalTime: '12:00 PM', dayOfWeek: 'Thursday', timezone: 'America/Toronto',
  }, messages: [{ content: message, role: 'user' }], sessionId: 'write-tools' }),
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://example.com' }, method: 'POST' });
}

async function verifyToken(token) {
  if (token !== TOKEN) throw new InvalidAccessTokenError();
  return { id: USER_ID };
}

test('multi-step loop reads context then resolves “that task” before writing', async () => {
  const repository = new InMemoryProjectRepository({ projects: [project()], tasks: [{ createdAt: NOW,
    id: 'task-only', position: 0, priority: 'normal', projectId: PROJECT_ID, status: 'todo', title: 'Send email', updatedAt: NOW }] });
  const read = createAssistantProjectToolExecutor(() => repository);
  const write = executor(repository);
  const responses = [
    openAIResponse([{ arguments: JSON.stringify({ focus: 'work', projectId: PROJECT_ID }), call_id: 'read', name: 'get_project_context', type: 'function_call' }]),
    openAIResponse([{ arguments: JSON.stringify(workArgs('complete_task', { entityId: 'task-only' })), call_id: 'write', name: 'manage_project_work', type: 'function_call' }]),
    openAIResponse([{ content: [{ text: 'Done — I marked Send email complete.', type: 'output_text' }], type: 'message' }]),
  ];
  const response = await handleAssistantRequest(request('Mark that task done.'), { allowedOrigin: 'https://example.com', apiKey: 'key',
    executeServerTool: (call, context) => call.name === 'get_project_context' ? read(call, context) : write(call, context),
    fetchImplementation: async () => responses.shift(), verifyAccessToken: verifyToken });

  assert.equal(response.status, 200);
  assert.equal((await repository.getTask('task-only')).status, 'completed');
});

test('exploratory language is governed by no-write instructions and invalid auth blocks writes', async () => {
  let executions = 0;
  let instructions = '';
  const response = await handleAssistantRequest(request('Maybe we should use burgundy instead.'), { allowedOrigin: 'https://example.com', apiKey: 'key',
    executeServerTool: async () => { executions += 1; throw new Error('unexpected'); },
    fetchImplementation: async (_url, init) => { instructions = JSON.parse(String(init.body)).instructions;
      return openAIResponse([{ content: [{ text: 'Would you like me to save burgundy as the replacement decision?', type: 'output_text' }], type: 'message' }]); },
    verifyAccessToken: verifyToken });
  assert.equal(response.status, 200);
  assert.equal(executions, 0);
  assert.match(instructions, /Brainstorming, maybe, perhaps/);

  const rejected = await handleAssistantRequest(request('Create a project.', 'invalid'), { allowedOrigin: 'https://example.com', apiKey: 'key',
    executeServerTool: async () => { executions += 1; throw new Error('unexpected'); }, fetchImplementation: async () => { throw new Error('unexpected'); }, verifyAccessToken: verifyToken });
  assert.equal(rejected.status, 401);
  assert.equal(executions, 0);
});
