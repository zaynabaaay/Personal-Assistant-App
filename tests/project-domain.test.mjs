import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectCurrentAcceptedKnowledge,
  selectUnresolvedQuestions,
} from '../src/domain/projects/project-selectors.ts';
import { InMemoryProjectRepository } from '../src/services/projects/in-memory-project-repository.ts';
import { ProjectService } from '../src/services/projects/project-service.ts';

const PROJECT_ID = 'project-1';
const CREATED_AT = '2026-08-11T13:00:00.000Z';
const OPERATION_TIME = '2026-08-11T15:00:00.000Z';

function createService(seed) {
  let idSequence = 1;
  const repository = new InMemoryProjectRepository(seed);
  const service = new ProjectService(repository, {
    createId: () => `generated-${idSequence++}`,
    now: () => new Date(OPERATION_TIME),
  });

  return { repository, service };
}

function task(overrides = {}) {
  return {
    createdAt: CREATED_AT,
    id: 'task-1',
    position: 0,
    priority: 'normal',
    projectId: PROJECT_ID,
    status: 'in_progress',
    title: 'Finish the project outline',
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function knowledge(overrides = {}) {
  return {
    content: 'The application deadline is October 15.',
    createdAt: CREATED_AT,
    id: 'knowledge-1',
    kind: 'fact',
    projectId: PROJECT_ID,
    status: 'current',
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    createdAt: CREATED_AT,
    decidedAt: CREATED_AT,
    id: 'decision-1',
    projectId: PROJECT_ID,
    statement: 'Use the community programs stream.',
    status: 'active',
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function workSession(overrides = {}) {
  return {
    createdAt: CREATED_AT,
    id: 'session-1',
    projectId: PROJECT_ID,
    startedAt: CREATED_AT,
    title: 'Planning session',
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

test('completing a task persists completion and a meaningful change event', async () => {
  const { repository, service } = createService({ tasks: [task()] });

  const result = await service.completeTask('task-1');

  assert.equal(result.value.status, 'completed');
  assert.equal(result.value.completedAt, OPERATION_TIME);
  assert.equal((await repository.getTask('task-1'))?.status, 'completed');
  assert.equal(result.changeEvent.eventType, 'task_completed');
  assert.deepEqual(
    (await repository.listChangeEvents(PROJECT_ID)).map((event) => event.eventType),
    ['task_completed'],
  );
});

test('current accepted knowledge excludes proposed, superseded, and unresolved questions', () => {
  const items = [
    knowledge(),
    knowledge({ id: 'proposed', status: 'proposed' }),
    knowledge({ id: 'superseded', status: 'superseded' }),
    knowledge({ id: 'question', kind: 'question', status: 'current' }),
  ];

  assert.deepEqual(
    selectCurrentAcceptedKnowledge(items).map((item) => item.id),
    ['knowledge-1'],
  );
  assert.deepEqual(
    selectUnresolvedQuestions(items).map((item) => item.id),
    ['question'],
  );
});

test('accepting proposed knowledge makes it current and records its provenance', async () => {
  const proposed = knowledge({
    id: 'proposed-1',
    sourceSessionId: 'session-1',
    status: 'proposed',
  });
  const { repository, service } = createService({ knowledgeItems: [proposed] });

  const result = await service.acceptProposedKnowledge(proposed.id);

  assert.equal(result.value.status, 'current');
  assert.equal(result.changeEvent.eventType, 'knowledge_accepted');
  assert.equal(result.changeEvent.sourceSessionId, 'session-1');
  assert.equal((await repository.getKnowledgeItem(proposed.id))?.status, 'current');
});

test('superseding knowledge preserves the old record and creates a current replacement', async () => {
  const current = knowledge();
  const { repository, service } = createService({ knowledgeItems: [current] });

  const result = await service.supersedeKnowledge(current.id, {
    content: 'The application deadline is October 22.',
    id: 'knowledge-2',
    kind: 'fact',
    sourceSessionId: 'session-1',
  });

  assert.equal(result.value.previous.status, 'superseded');
  assert.equal(result.value.replacement.status, 'current');
  assert.equal(result.value.replacement.supersedesKnowledgeItemId, current.id);
  assert.equal((await repository.getKnowledgeItem(current.id))?.status, 'superseded');
  assert.equal((await repository.getKnowledgeItem('knowledge-2'))?.status, 'current');
  assert.equal(result.changeEvent.eventType, 'knowledge_superseded');
});

test('superseding a decision preserves history and activates the replacement', async () => {
  const current = decision();
  const { repository, service } = createService({ decisions: [current] });

  const result = await service.supersedeDecision(current.id, {
    id: 'decision-2',
    rationale: 'The eligibility guidance changed.',
    sourceSessionId: 'session-1',
    statement: 'Use the neighbourhood initiatives stream.',
  });

  assert.equal(result.value.previous.status, 'superseded');
  assert.equal(result.value.replacement.status, 'active');
  assert.equal(result.value.replacement.supersedesDecisionId, current.id);
  assert.equal((await repository.getDecision(current.id))?.status, 'superseded');
  assert.equal((await repository.getDecision('decision-2'))?.status, 'active');
  assert.equal(result.changeEvent.eventType, 'decision_superseded');
});

test('closing a work session preserves and returns its ordered raw entries', async () => {
  const entries = [
    {
      content: 'Assistant response',
      id: 'entry-2',
      kind: 'assistant_message',
      occurredAt: '2026-08-11T13:02:00.000Z',
      position: 2,
      sessionId: 'session-1',
    },
    {
      content: 'Raw user thought',
      id: 'entry-1',
      kind: 'user_message',
      occurredAt: '2026-08-11T13:01:00.000Z',
      position: 1,
      sessionId: 'session-1',
    },
  ];
  const { repository, service } = createService({
    workSessionEntries: entries,
    workSessions: [workSession()],
  });

  const result = await service.closeWorkSession(
    'session-1',
    '  Reviewed the project direction.  ',
  );

  assert.equal(result.value.session.endedAt, OPERATION_TIME);
  assert.equal(result.value.session.summary, 'Reviewed the project direction.');
  assert.deepEqual(
    result.value.entries.map((entry) => [entry.id, entry.content]),
    [
      ['entry-1', 'Raw user thought'],
      ['entry-2', 'Assistant response'],
    ],
  );
  assert.deepEqual(
    (await repository.listWorkSessionEntries('session-1')).map((entry) => entry.content),
    ['Raw user thought', 'Assistant response'],
  );
  assert.equal(result.changeEvent.eventType, 'work_session_closed');
});

test('only meaningful service operations create change events', async () => {
  const { repository } = createService({
    knowledgeItems: [knowledge()],
    tasks: [task()],
    workSessions: [workSession()],
  });

  await repository.saveKnowledgeItem(
    knowledge({ content: 'Edited wording without changing meaning.' }),
  );
  await repository.saveTask(task({ title: 'Edited task title' }));

  assert.deepEqual(await repository.listChangeEvents(PROJECT_ID), []);
});

