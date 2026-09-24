import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ConversationProjectProcessor } from '../src/services/conversations/conversation-project-processor.ts';
import {
  ConversationProcessingInProgressError,
  StaleProjectStateError,
} from '../src/services/conversations/conversation-project-processing-repository.ts';
import { InMemoryProjectRepository } from '../src/services/projects/in-memory-project-repository.ts';
import { OpenAIConversationProjectAnalyzer } from '../src/server/conversations/openai-conversation-project-analyzer.ts';
import { createAssistantProjectToolExecutor } from '../src/server/assistant/project-tool-executor.ts';
import { handleConversationProjectProcessing } from '../api/process-conversation.ts';
import {
  ASSISTANT_CLIENT_HEADER,
  ASSISTANT_CLIENT_ID,
} from '../src/contracts/assistant/assistant-contract.ts';

const STARTED_AT = '2026-08-21T14:00:00.000Z';
const COMPLETED_AT = '2026-08-21T14:30:00.000Z';

function project(id, name) {
  return {
    createdAt: STARTED_AT,
    id,
    name,
    priority: 'normal',
    status: 'active',
    timezone: 'America/Toronto',
    type: 'general',
    updatedAt: STARTED_AT,
  };
}

function message(id, content, position, role = 'user', conversationId = 'conversation-1') {
  return {
    content,
    conversationId,
    id,
    occurredAt: `2026-08-21T14:${String(position).padStart(2, '0')}:00.000Z`,
    position,
    role,
  };
}

function completedConversation(messages, conversationId = 'conversation-1') {
  return {
    conversation: {
      completedAt: COMPLETED_AT,
      createdAt: STARTED_AT,
      id: conversationId,
      messageCount: messages.length,
      metadataStatus: 'fallback',
      processingAttempts: 0,
      processingStatus: 'pending',
      startedAt: STARTED_AT,
      status: 'completed',
      summary: `Completed conversation with ${messages.length} messages.`,
      title: 'Conversation',
      updatedAt: COMPLETED_AT,
    },
    messages,
  };
}

function emptyReconciliation(summary = 'Reviewed the Project.') {
  return { candidates: [], summary, title: 'Conversation review' };
}

function candidate(value) {
  return {
    evidenceMessageIds: ['m0'],
    subjectKey: value.title ?? value.target,
    ...value,
  };
}

class StaticAnalyzer {
  constructor(matches, reconciliations) {
    this.matches = matches;
    this.reconciliations = reconciliations;
    this.matchCalls = 0;
    this.reconcileCalls = [];
  }

  async matchProjectSegments() {
    this.matchCalls += 1;
    return structuredClone(this.matches);
  }

  async reconcileProjectSegment(input) {
    this.reconcileCalls.push({
      messageIds: [...input.relevantMessageIds],
      projectId: input.project.id,
      snapshot: structuredClone(input.snapshot),
    });
    return structuredClone(this.reconciliations[input.project.id]);
  }
}

class InMemoryProcessingRepository {
  constructor(conversation, projectRepository) {
    this.record = structuredClone(conversation);
    this.projectRepository = projectRepository;
    this.checkpoints = new Map();
    this.pendingCandidates = new Map();
    this.failProjectOnce = null;
    this.commits = [];
    this.planWaiters = [];
    this.beforeFirstCommit = null;
  }

  async claim(id) {
    assert.equal(id, this.record.conversation.id);
    if (this.record.conversation.processingStatus === 'processed') {
      return { conversation: structuredClone(this.record), status: 'processed' };
    }
    if (this.record.conversation.processingStatus === 'processing' &&
      !this.record.conversation.processingPlan) {
      await new Promise((resolve) => this.planWaiters.push(resolve));
      return { conversation: structuredClone(this.record), status: 'processing' };
    }
    this.record.conversation.processingStatus = 'processing';
    this.record.conversation.processingAttempts += 1;
    for (const checkpoint of this.checkpoints.values()) {
      if (!['processed', 'skipped'].includes(checkpoint.status)) {
        checkpoint.status = 'processing';
        checkpoint.processingAttempts += 1;
      }
    }
    return { conversation: structuredClone(this.record), status: 'processing' };
  }

  async savePlan(conversationId, plan, sessions) {
    assert.equal(conversationId, this.record.conversation.id);
    if (this.record.conversation.processingPlan) {
      return structuredClone(this.record.conversation.processingPlan);
    } else {
      this.record.conversation.processingPlan = structuredClone(plan);
    }
    for (const value of sessions) {
      if (!this.checkpoints.has(value.projectId)) {
        this.checkpoints.set(value.projectId, {
          conversationId,
          processingAttempts: 1,
          projectId: value.projectId,
          sessionId: value.sessionId,
          status: 'processing',
          updatedAt: COMPLETED_AT,
        });
      }
    }
    this.planWaiters.splice(0).forEach((resolve) => resolve());
    return structuredClone(this.record.conversation.processingPlan);
  }

  async listCheckpoints() {
    return [...this.checkpoints.values()].map((value) => structuredClone(value));
  }

  async commitProjectResult(input) {
    if (this.beforeFirstCommit) {
      const action = this.beforeFirstCommit;
      this.beforeFirstCommit = null;
      await action(input);
    }
    const checkpoint = this.checkpoints.get(input.projectId);
    if (checkpoint?.status === 'processed') return 'processed';
    const currentProject = await this.projectRepository.getProject(input.projectId);
    if (!currentProject || ['archived', 'cancelled'].includes(currentProject.status)) {
      checkpoint.status = 'skipped';
      return 'skipped';
    }
    if (this.failProjectOnce === input.projectId) {
      this.failProjectOnce = null;
      throw new Error(`simulated failure for ${input.projectId}`);
    }
    await this.projectRepository.saveAtomically(input.changes);
    input.candidates.forEach((value) => this.pendingCandidates.set(value.id, structuredClone(value)));
    this.checkpoints.get(input.projectId).status = 'processed';
    this.commits.push(input.projectId);
    return 'processed';
  }

  async fail(_conversationId, projectId, error) {
    if (this.record.conversation.processingStatus === 'processed') return;
    this.record.conversation.processingStatus = 'failed';
    this.record.conversation.lastProcessingError = error;
    if (projectId && !['processed', 'skipped'].includes(this.checkpoints.get(projectId)?.status)) {
      this.checkpoints.get(projectId).status = 'failed';
    }
  }

  async complete() {
    assert.equal(
      [...this.checkpoints.values()].some((value) =>
        !['processed', 'skipped'].includes(value.status)),
      false,
    );
    this.record.conversation.processingStatus = 'processed';
    delete this.record.conversation.lastProcessingError;
  }
}

class SerializedProcessingRepository extends InMemoryProcessingRepository {
  constructor(conversation, projectRepository, locks) {
    super(conversation, projectRepository);
    this.locks = locks;
  }

  async commitProjectResult(input) {
    const previous = this.locks.get(input.projectId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this.locks.set(input.projectId, previous.then(() => gate));
    await previous;
    try {
      for (const condition of input.preconditions.filter((value) => value.operation === 'create')) {
        const values = condition.entityType === 'knowledge'
          ? await this.projectRepository.listKnowledgeItems(input.projectId)
          : condition.entityType === 'decision'
            ? await this.projectRepository.listDecisions(input.projectId)
            : await this.projectRepository.listTasks(input.projectId);
        if (values.some((value) => value.derivedIdentity === condition.derivedIdentity &&
          !['superseded', 'cancelled'].includes(value.status))) {
          throw new StaleProjectStateError('Project state changed after analysis.');
        }
      }
      return await super.commitProjectResult(input);
    } finally {
      release();
    }
  }
}

function setup({ messages, projects, matches, reconciliations, seed = {} }) {
  const projectRepository = new InMemoryProjectRepository({ projects, ...seed });
  const processingRepository = new InMemoryProcessingRepository(
    completedConversation(messages),
    projectRepository,
  );
  const analyzer = new StaticAnalyzer(matches, reconciliations);
  const processor = new ConversationProjectProcessor(
    analyzer,
    processingRepository,
    projectRepository,
  );
  return { analyzer, processingRepository, processor, projectRepository };
}

test('one Project plus an unrelated topic creates one bounded linked session without raw transcript storage', async () => {
  const aqal = project('aqal', 'AQAL');
  const messages = [
    message('m0', 'For AQAL, compare the manufacturer lead times.', 0),
    message('m1', 'What should I eat today?', 1),
    message('m2', 'AQAL still needs a quality sample.', 2),
  ];
  const state = setup({
    matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0', 'm2'] }],
    messages,
    projects: [aqal],
    reconciliations: {
      aqal: emptyReconciliation('Compared manufacturer lead times and noted the need for a quality sample.'),
    },
  });

  const result = await state.processor.process('conversation-1');
  const sessions = await state.projectRepository.listWorkSessions('aqal');

  assert.deepEqual(result, { projectCount: 1, status: 'processed' });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sourceConversationId, 'conversation-1');
  assert.match(sessions[0].summary, /manufacturer lead times/);
  assert.doesNotMatch(sessions[0].summary, /eat|food/i);
  assert.deepEqual(await state.projectRepository.listWorkSessionEntries(sessions[0].id), []);
});

test('two Projects are separated and repeated switches back to one Project form one coherent session', async () => {
  const messages = [
    message('m0', 'AQAL manufacturer research first.', 0),
    message('m1', 'For Woke to Dream, the funding deadline matters.', 1),
    message('m2', 'Back to AQAL: request the fabric sample.', 2),
  ];
  const state = setup({
    matches: [
      { confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0'] },
      { confidence: 'high', projectId: 'wtd', relevantMessageIds: ['m1'] },
      { confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m2'] },
    ],
    messages,
    projects: [project('aqal', 'AQAL'), project('wtd', 'Woke to Dream')],
    reconciliations: {
      aqal: emptyReconciliation('Reviewed manufacturer research and the fabric-sample request.'),
      wtd: emptyReconciliation('Reviewed the funding deadline.'),
    },
  });

  await state.processor.process('conversation-1');

  assert.equal((await state.projectRepository.listWorkSessions('aqal')).length, 1);
  assert.equal((await state.projectRepository.listWorkSessions('wtd')).length, 1);
  assert.deepEqual(state.analyzer.reconcileCalls.find((value) => value.projectId === 'aqal').messageIds, ['m0', 'm2']);
});

test('a conversation with no high-confidence Project material creates no Project session', async () => {
  const state = setup({
    matches: [{ confidence: 'medium', projectId: 'aqal', relevantMessageIds: ['m0'] }],
    messages: [message('m0', 'I finished today’s reading.', 0)],
    projects: [project('aqal', 'AQAL')],
    reconciliations: {},
  });

  assert.deepEqual(await state.processor.process('conversation-1'), {
    projectCount: 0,
    status: 'processed',
  });
  assert.deepEqual(await state.projectRepository.listWorkSessions('aqal'), []);
});

test('current truth is loaded before reconciliation and revisits do not duplicate it', async () => {
  const linen = {
    content: 'Linen is the confirmed material direction.',
    createdAt: STARTED_AT,
    id: 'linen',
    kind: 'fact',
    projectId: 'aqal',
    status: 'current',
    updatedAt: STARTED_AT,
  };
  const task = {
    createdAt: STARTED_AT,
    id: 'manufacturer-task',
    position: 0,
    priority: 'normal',
    projectId: 'aqal',
    status: 'todo',
    title: 'Ask manufacturer about lead time',
    updatedAt: STARTED_AT,
  };
  const state = setup({
    matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0'] }],
    messages: [message('m0', 'For AQAL, maybe linen would work. I still need the lead-time answer.', 0)],
    projects: [project('aqal', 'AQAL')],
    reconciliations: {
      aqal: {
        candidates: [
          candidate({ classification: 'already_known', content: 'Linen is the material direction.', existingEntityId: 'linen', knowledgeKind: 'fact', rationale: null, target: 'knowledge', title: null, usefulPending: false }),
          candidate({ classification: 'already_known', content: 'Ask manufacturer about lead time', existingEntityId: 'manufacturer-task', knowledgeKind: null, rationale: null, target: 'task', title: 'Ask manufacturer about lead time', usefulPending: false }),
        ],
        summary: 'Revisited linen and the existing manufacturer lead-time question.',
        title: 'Material and manufacturer revisit',
      },
    },
    seed: { knowledgeItems: [linen], tasks: [task] },
  });

  await state.processor.process('conversation-1');

  assert.equal(state.analyzer.reconcileCalls[0].snapshot.knowledgeItems[0].id, 'linen');
  assert.equal(state.analyzer.reconcileCalls[0].snapshot.tasks[0].id, 'manufacturer-task');
  assert.equal((await state.projectRepository.listKnowledgeItems('aqal')).length, 1);
  assert.equal((await state.projectRepository.listTasks('aqal')).length, 1);
  assert.equal((await state.projectRepository.listWorkSessions('aqal')).length, 1);
});

test('an explicit shorthand Project revisit creates the newest work session even when model matching omits it', async () => {
  const aqal = project('aqal', 'AQAL Collective');
  const oldSession = {
    createdAt: '2026-08-20T12:00:00.000Z',
    endedAt: '2026-08-20T12:10:00.000Z',
    id: 'old-manufacturer-session',
    projectId: 'aqal',
    startedAt: '2026-08-20T12:00:00.000Z',
    summary: 'Completed the first manufacturer outreach.',
    title: 'Manufacturer outreach',
    updatedAt: '2026-08-20T12:10:00.000Z',
  };
  const messages = [
    message('m0', 'I want to work on AQAL. Which manufacturer can handle smaller minimum orders?', 0),
    message('m1', 'We can compare manufacturers by their minimum order quantity.', 1, 'assistant'),
    message('m2', 'What can I make for dinner?', 2),
    message('m3', 'You could make lentil soup.', 3, 'assistant'),
    message('m4', 'Back to AQAL — linen is still the direction.', 4),
    message('m5', 'Linen remains the current direction.', 5, 'assistant'),
  ];
  const state = setup({
    matches: [],
    messages,
    projects: [aqal],
    reconciliations: {
      aqal: emptyReconciliation(
        'Revisited linen and explored manufacturers that can handle smaller minimum orders.',
      ),
    },
    seed: { workSessions: [oldSession] },
  });

  await state.processor.process('conversation-1');

  assert.deepEqual(state.analyzer.reconcileCalls[0].messageIds, ['m0', 'm1', 'm4', 'm5']);
  const execute = createAssistantProjectToolExecutor(() => state.projectRepository);
  const output = await execute({
    arguments: { focus: 'history', projectId: 'aqal' },
    callId: 'latest-session',
    execution: 'server',
    name: 'get_project_context',
  }, { accessToken: 'test-token', userId: 'test-user' });

  assert.equal(output.result.status, 'success');
  assert.match(output.result.recentWorkSessions[0].summary, /smaller minimum orders/);
  assert.equal(output.result.recentWorkSessions[1].id, 'old-manufacturer-session');
});

test('a pure Project history lookup is not forced into a new work session when analysis omits it', async () => {
  const state = setup({
    matches: [],
    messages: [message('m0', 'What did we work on for AQAL last time?', 0)],
    projects: [project('aqal', 'AQAL Collective')],
    reconciliations: {},
  });

  assert.deepEqual(await state.processor.process('conversation-1'), {
    projectCount: 0,
    status: 'processed',
  });
  assert.deepEqual(await state.projectRepository.listWorkSessions('aqal'), []);
});

test('clear new information and confirmed decisions persist while brainstorming stays pending', async () => {
  const state = setup({
    matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0'] }],
    messages: [message('m0', 'For AQAL, the minimum order is 100. We decided on Studio North. Maybe change the colors.', 0)],
    projects: [project('aqal', 'AQAL')],
    reconciliations: {
      aqal: {
        candidates: [
          candidate({ classification: 'new', content: 'The manufacturer minimum order is 100 units.', existingEntityId: null, knowledgeKind: 'fact', rationale: null, target: 'knowledge', title: 'Manufacturer minimum order', usefulPending: false }),
          candidate({ classification: 'confirmed_decision', content: 'Use Studio North as the manufacturer.', existingEntityId: null, knowledgeKind: null, rationale: 'The user explicitly chose it.', subjectKey: 'manufacturer-choice', target: 'decision', title: null, usefulPending: false }),
          candidate({ classification: 'brainstorming', content: 'Possibly change the AQAL colors.', existingEntityId: null, knowledgeKind: null, rationale: null, subjectKey: 'color-direction', target: 'knowledge', title: null, usefulPending: true }),
        ],
        summary: 'Recorded the minimum order, confirmed Studio North, and explored a possible color change.',
        title: 'Manufacturer direction',
      },
    },
  });

  await state.processor.process('conversation-1');

  assert.equal((await state.projectRepository.listKnowledgeItems('aqal')).length, 1);
  assert.equal((await state.projectRepository.listDecisions('aqal')).length, 1);
  const pending = [...state.processingRepository.pendingCandidates.values()];
  assert.equal(pending.length, 1);
  assert.deepEqual(Object.keys(pending[0]).sort(), [
    'content', 'conversationId', 'createdAt', 'id', 'projectId', 'sessionId', 'status',
  ]);
  assert.equal(pending[0].conversationId, 'conversation-1');
});

test('a clear update supersedes current knowledge while preserving the historical record', async () => {
  const existing = {
    content: 'The launch is September 1.', createdAt: STARTED_AT, id: 'launch-date',
    kind: 'fact', projectId: 'aqal', status: 'current', updatedAt: STARTED_AT,
  };
  const state = setup({
    matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0'] }],
    messages: [message('m0', 'For AQAL, the launch is now definitely September 15.', 0)],
    projects: [project('aqal', 'AQAL')],
    reconciliations: {
      aqal: {
        candidates: [candidate({ classification: 'clear_update', content: 'The launch is September 15.', existingEntityId: 'launch-date', knowledgeKind: 'fact', rationale: null, target: 'knowledge', title: 'Launch date', usefulPending: false })],
        summary: 'Confirmed the revised launch date.', title: 'Launch update',
      },
    },
    seed: { knowledgeItems: [existing] },
  });

  await state.processor.process('conversation-1');
  const values = await state.projectRepository.listKnowledgeItems('aqal');
  assert.equal(values.find((value) => value.id === 'launch-date').status, 'superseded');
  assert.equal(values.find((value) => value.status === 'current').supersedesKnowledgeItemId, 'launch-date');
});

test('similar Projects and assistant-only or unrelated evidence fail closed', async () => {
  const similar = setup({
    matches: [{ confidence: 'high', projectId: 'aqal-main', relevantMessageIds: ['m0'] }],
    messages: [message('m0', 'The manufacturer timeline needs attention.', 0)],
    projects: [
      { ...project('aqal-main', 'AQAL Main'), description: 'Manufacturer timeline and samples' },
      { ...project('aqal-launch', 'AQAL Launch'), description: 'Manufacturer timeline and launch' },
    ],
    reconciliations: {},
  });
  assert.equal((await similar.processor.process('conversation-1')).projectCount, 0);

  const ambiguousShorthand = setup({
    matches: [],
    messages: [message('m0', 'I want to work on AQAL and compare manufacturers.', 0)],
    projects: [project('aqal-main', 'AQAL Main'), project('aqal-launch', 'AQAL Launch')],
    reconciliations: {},
  });
  assert.equal((await ambiguousShorthand.processor.process('conversation-1')).projectCount, 0);

  const badEvidence = setup({
    matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0', 'm1'] }],
    messages: [
      message('m0', 'AQAL manufacturer research.', 0, 'assistant'),
      message('m1', 'What should I eat?', 1),
    ],
    projects: [project('aqal', 'AQAL')],
    reconciliations: {},
  });
  assert.equal((await badEvidence.processor.process('conversation-1')).projectCount, 0);
});

test('assistant-only and unrelated candidate evidence cannot change Project truth', async () => {
  const state = setup({
    matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0', 'm1', 'm2'] }],
    messages: [
      message('m0', 'AQAL manufacturer planning.', 0),
      message('m1', 'Studio North is confirmed.', 1, 'assistant'),
      message('m2', 'What should I eat?', 2),
    ],
    projects: [project('aqal', 'AQAL')],
    reconciliations: {
      aqal: {
        candidates: [
          candidate({ classification: 'confirmed_decision', content: 'Use Studio North.', evidenceMessageIds: ['m1'], existingEntityId: null, knowledgeKind: null, rationale: null, subjectKey: 'manufacturer-choice', target: 'decision', title: null, usefulPending: false }),
          candidate({ classification: 'new', content: 'Minimum order is 100.', evidenceMessageIds: ['m2'], existingEntityId: null, knowledgeKind: 'fact', rationale: null, subjectKey: 'minimum-order', target: 'knowledge', title: null, usefulPending: false }),
        ],
        summary: 'Reviewed manufacturer planning.', title: 'Manufacturer planning',
      },
    },
  });
  await state.processor.process('conversation-1');
  assert.equal((await state.projectRepository.listDecisions('aqal')).length, 0);
  assert.equal((await state.projectRepository.listKnowledgeItems('aqal')).length, 0);
});

test('exploratory evidence cannot be promoted to a confirmed decision', async () => {
  const state = setup({
    matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0'] }],
    messages: [message('m0', 'For AQAL, maybe we should use Studio North.', 0)],
    projects: [project('aqal', 'AQAL')],
    reconciliations: { aqal: {
      candidates: [candidate({ classification: 'confirmed_decision', content: 'Use Studio North.', existingEntityId: null, knowledgeKind: null, rationale: null, subjectKey: 'manufacturer-choice', target: 'decision', title: null, usefulPending: false })],
      summary: 'Considered Studio North.', title: 'Manufacturer option',
    } },
  });
  await state.processor.process('conversation-1');
  assert.equal((await state.projectRepository.listDecisions('aqal')).length, 0);
  assert.equal(state.processingRepository.pendingCandidates.size, 1);
});

test('unresolved same-topic decisions and updates remain pending instead of creating conflicting truth', async () => {
  const existing = { content: 'Launch is September 1.', createdAt: STARTED_AT, id: 'launch',
    kind: 'fact', projectId: 'aqal', status: 'current', updatedAt: STARTED_AT };
  const state = setup({
    matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0', 'm1', 'm2', 'm3'] }],
    messages: [
      message('m0', 'For AQAL, we decided on blue.', 0),
      message('m1', 'For AQAL, we decided on red.', 1),
      message('m2', 'AQAL launch is definitely September 15.', 2),
      message('m3', 'AQAL launch is definitely October 1.', 3),
    ],
    projects: [project('aqal', 'AQAL')],
    reconciliations: { aqal: {
      candidates: [
        candidate({ classification: 'confirmed_decision', content: 'Use blue.', evidenceMessageIds: ['m0'], existingEntityId: null, knowledgeKind: null, rationale: null, subjectKey: 'color-direction', target: 'decision', title: null, usefulPending: false }),
        candidate({ classification: 'confirmed_decision', content: 'Use red.', evidenceMessageIds: ['m1'], existingEntityId: null, knowledgeKind: null, rationale: null, subjectKey: 'color-direction', target: 'decision', title: null, usefulPending: false }),
        candidate({ classification: 'clear_update', content: 'Launch is September 15.', evidenceMessageIds: ['m2'], existingEntityId: 'launch', knowledgeKind: 'fact', rationale: null, subjectKey: 'launch-date', target: 'knowledge', title: 'Launch date', usefulPending: false }),
        candidate({ classification: 'clear_update', content: 'Launch is October 1.', evidenceMessageIds: ['m3'], existingEntityId: 'launch', knowledgeKind: 'fact', rationale: null, subjectKey: 'launch-date', target: 'knowledge', title: 'Launch date', usefulPending: false }),
      ],
      summary: 'Discussed unresolved color and launch alternatives.', title: 'Open directions',
    } },
    seed: { knowledgeItems: [existing] },
  });
  await state.processor.process('conversation-1');
  assert.equal((await state.projectRepository.listDecisions('aqal')).length, 0);
  assert.equal((await state.projectRepository.listKnowledgeItems('aqal')).filter((value) => value.status === 'current').length, 1);
  assert.equal(state.processingRepository.pendingCandidates.size, 4);
});

test('candidate B reconciles against candidate A projected state', async () => {
  const state = setup({
    matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0'] }],
    messages: [message('m0', 'For AQAL, the minimum order is 100 units.', 0)],
    projects: [project('aqal', 'AQAL')],
    reconciliations: { aqal: {
      candidates: [0, 1].map(() => candidate({ classification: 'new', content: 'Minimum order is 100 units.', existingEntityId: null, knowledgeKind: 'fact', rationale: null, subjectKey: 'minimum-order', target: 'knowledge', title: 'Minimum order', usefulPending: false })),
      summary: 'Recorded the minimum order.', title: 'Order requirement',
    } },
  });
  await state.processor.process('conversation-1');
  assert.equal((await state.projectRepository.listKnowledgeItems('aqal')).length, 1);
  assert.equal(state.processingRepository.commits.length, 1);
});

test('concurrent requests for one conversation reuse one plan and cannot downgrade success', async () => {
  const state = setup({
    matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0'] }],
    messages: [message('m0', 'AQAL planning update.', 0)],
    projects: [project('aqal', 'AQAL')],
    reconciliations: { aqal: emptyReconciliation('Reviewed AQAL planning.') },
  });
  const results = await Promise.all([
    state.processor.process('conversation-1'),
    state.processor.process('conversation-1'),
  ]);
  assert.equal(state.analyzer.matchCalls, 1);
  assert.equal((await state.projectRepository.listWorkSessions('aqal')).length, 1);
  assert.equal(results.length, 2);
  await state.processingRepository.fail('conversation-1', 'aqal', 'late failure');
  assert.equal(state.processingRepository.record.conversation.processingStatus, 'processed');
});

test('different conversations concurrently adding equivalent truth produce one truth record', async () => {
  const projects = new InMemoryProjectRepository({ projects: [project('aqal', 'AQAL')] });
  const locks = new Map();
  const build = (conversationId, messageId) => {
    const messages = [message(messageId, 'For AQAL, the minimum order is 100 units.', 0, 'user', conversationId)];
    const processing = new SerializedProcessingRepository(
      completedConversation(messages, conversationId), projects, locks,
    );
    const analyzer = new StaticAnalyzer(
      [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: [messageId] }],
      { aqal: {
        candidates: [candidate({ classification: 'new', content: 'Minimum order is 100 units.', evidenceMessageIds: [messageId], existingEntityId: null, knowledgeKind: 'fact', rationale: null, subjectKey: 'minimum-order', target: 'knowledge', title: 'Minimum order', usefulPending: false })],
        summary: 'Recorded the minimum order.', title: 'Order requirement',
      } },
    );
    return { processing, processor: new ConversationProjectProcessor(analyzer, processing, projects) };
  };
  const first = build('conversation-a', 'a0');
  const second = build('conversation-b', 'b0');
  await Promise.all([
    first.processor.process('conversation-a'),
    second.processor.process('conversation-b'),
  ]);
  assert.equal((await projects.listKnowledgeItems('aqal')).length, 1);
  assert.equal((await projects.listWorkSessions('aqal')).length, 2);
});

test('state changes after analysis are re-read and equivalent new truth is skipped', async () => {
  const state = setup({
    matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0'] }],
    messages: [message('m0', 'For AQAL, the minimum order is 100 units.', 0)],
    projects: [project('aqal', 'AQAL')],
    reconciliations: { aqal: {
      candidates: [candidate({ classification: 'new', content: 'Minimum order is 100 units.', existingEntityId: null, knowledgeKind: 'fact', rationale: null, subjectKey: 'minimum-order', target: 'knowledge', title: 'Minimum order', usefulPending: false })],
      summary: 'Recorded the minimum order.', title: 'Order requirement',
    } },
  });
  state.processingRepository.beforeFirstCommit = async () => {
    await state.projectRepository.saveKnowledgeItem({
      content: 'Minimum order is 100 units.', createdAt: STARTED_AT,
      derivedIdentity: 'minimum-order', id: 'concurrent-minimum', kind: 'fact',
      projectId: 'aqal', status: 'current', updatedAt: COMPLETED_AT,
    });
    throw new StaleProjectStateError('Project state changed after analysis.');
  };
  await state.processor.process('conversation-1');
  assert.equal((await state.projectRepository.listKnowledgeItems('aqal')).length, 1);
  assert.equal((await state.projectRepository.listWorkSessions('aqal')).length, 1);
});

test('a stale replacement is not committed and is preserved as pending', async () => {
  const existing = { content: 'Launch is September 1.', createdAt: STARTED_AT, id: 'launch',
    kind: 'fact', projectId: 'aqal', status: 'current', updatedAt: STARTED_AT };
  const state = setup({
    matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0'] }],
    messages: [message('m0', 'For AQAL, the launch is now definitely September 15.', 0)],
    projects: [project('aqal', 'AQAL')],
    reconciliations: { aqal: {
      candidates: [candidate({ classification: 'clear_update', content: 'Launch is September 15.', existingEntityId: 'launch', knowledgeKind: 'fact', rationale: null, subjectKey: 'launch-date', target: 'knowledge', title: 'Launch date', usefulPending: false })],
      summary: 'Reviewed a launch change.', title: 'Launch date',
    } },
    seed: { knowledgeItems: [existing] },
  });
  state.processingRepository.beforeFirstCommit = async () => {
    await state.projectRepository.saveKnowledgeItem({ ...existing, status: 'superseded', updatedAt: COMPLETED_AT });
    await state.projectRepository.saveKnowledgeItem({
      content: 'Launch is October 1.', createdAt: COMPLETED_AT,
      derivedIdentity: 'launch-date', id: 'concurrent-launch', kind: 'fact',
      projectId: 'aqal', status: 'current', supersedesKnowledgeItemId: 'launch', updatedAt: COMPLETED_AT,
    });
    throw new StaleProjectStateError('Project replacement is stale.');
  };
  await state.processor.process('conversation-1');
  const current = (await state.projectRepository.listKnowledgeItems('aqal'))
    .filter((value) => value.status === 'current');
  assert.deepEqual(current.map((value) => value.content), ['Launch is October 1.']);
  assert.equal(state.processingRepository.pendingCandidates.size, 1);
});

test('a Project archived or cancelled between analysis and commit receives no derived writes', async (t) => {
  for (const status of ['archived', 'cancelled']) {
    await t.test(status, async () => {
      const state = setup({
        matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0'] }],
        messages: [message('m0', 'AQAL manufacturer planning.', 0)],
        projects: [project('aqal', 'AQAL')],
        reconciliations: { aqal: emptyReconciliation('Reviewed manufacturer planning.') },
      });
      state.processingRepository.beforeFirstCommit = async () => {
        await state.projectRepository.saveProject({ ...project('aqal', 'AQAL'), status });
      };
      await state.processor.process('conversation-1');
      assert.equal((await state.projectRepository.listWorkSessions('aqal')).length, 0);
      assert.equal(state.processingRepository.checkpoints.get('aqal').status, 'skipped');
    });
  }
});

test('reprocessing is idempotent and a partial multi-Project failure retries only unfinished work', async () => {
  const state = setup({
    matches: [
      { confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0'] },
      { confidence: 'high', projectId: 'wtd', relevantMessageIds: ['m1'] },
    ],
    messages: [message('m0', 'AQAL update.', 0), message('m1', 'Woke to Dream update.', 1)],
    projects: [project('aqal', 'AQAL'), project('wtd', 'Woke to Dream')],
    reconciliations: { aqal: emptyReconciliation('AQAL update.'), wtd: emptyReconciliation('Funding update.') },
  });
  state.processingRepository.failProjectOnce = 'wtd';

  await assert.rejects(state.processor.process('conversation-1'), /simulated failure/);
  assert.equal((await state.projectRepository.listWorkSessions('aqal')).length, 1);
  assert.equal((await state.projectRepository.listWorkSessions('wtd')).length, 0);

  assert.deepEqual(await state.processor.process('conversation-1'), { projectCount: 2, status: 'processed' });
  assert.equal((await state.projectRepository.listWorkSessions('aqal')).length, 1);
  assert.equal((await state.projectRepository.listWorkSessions('wtd')).length, 1);
  assert.deepEqual(state.processingRepository.commits, ['aqal', 'wtd']);
  assert.equal(state.analyzer.matchCalls, 1);
  assert.deepEqual(await state.processor.process('conversation-1'), { projectCount: 2, status: 'already_processed' });
});

test('the processing migration preserves ownership, source links, checkpoints, and atomic Project commits', async () => {
  const migration = await readFile(new URL(
    '../supabase/migrations/20260821120000_create_conversation_project_processing.sql',
    import.meta.url,
  ), 'utf8');

  assert.match(migration, /source_conversation_id/);
  assert.match(migration, /references public\.completed_conversations\(owner_id, id\)/);
  assert.match(migration, /owner_id = \(select auth\.uid\(\)\)/g);
  assert.match(migration, /commit_conversation_project_result/);
  assert.match(migration, /private\.upsert_owned_project_rows/);
  assert.match(migration, /status = 'processed'/);
  assert.match(migration, /processing_plan/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /hashtextextended\(authenticated_owner::text \|\| ':' \|\| p_project_id/);
  assert.match(migration, /derived_identity/);
  assert.match(migration, /project_knowledge_derived_identity_idx/);
  assert.match(migration, /using errcode = '40001'/);
  assert.match(migration, /project_status in \('archived', 'cancelled'\)/);
  assert.match(migration, /return 'waiting'/);
  assert.match(migration, /return existing_plan/);
  assert.match(migration, /processing_status <> 'processed'/);
  assert.match(migration, /status in \('processed', 'skipped'\)/);
  assert.match(migration, /security definer\s+set search_path = ''/g);
  assert.doesNotMatch(migration, /p_owner|p_user/);
});

test('database contracts enforce transcript bounds and owner-scoped RLS', async () => {
  const completionMigration = await readFile(new URL(
    '../supabase/migrations/20260821090000_create_completed_conversations.sql',
    import.meta.url,
  ), 'utf8');
  const processingMigration = await readFile(new URL(
    '../supabase/migrations/20260821120000_create_conversation_project_processing.sql',
    import.meta.url,
  ), 'utf8');
  assert.match(completionMigration, /supplied_message_count > 50/);
  assert.match(completionMigration, /length\(content\) <= 4000/);
  assert.match(completionMigration, /> 30000/);
  for (const migration of [completionMigration, processingMigration]) {
    assert.match(migration, /enable row level security/);
    assert.match(migration, /owner_id = \(select auth\.uid\(\)\)/);
    assert.doesNotMatch(migration, /service_role/);
  }
});

test('the OpenAI analyzer requests strict structured matching and supplies current truth before reconciliation', async () => {
  const requests = [];
  const responses = [
    { matches: [{ confidence: 'high', projectId: 'aqal', relevantMessageIds: ['m0'] }] },
    {
      candidates: [candidate({ classification: 'already_known', content: 'Linen is confirmed.', existingEntityId: 'linen', knowledgeKind: 'fact', rationale: null, target: 'knowledge', title: null, usefulPending: false })],
      summary: 'Revisited the confirmed linen direction.',
      title: 'Material revisit',
    },
  ];
  const analyzer = new OpenAIConversationProjectAnalyzer({
    apiKey: 'test-key',
    fetchImplementation: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      const value = responses.shift();
      return new Response(JSON.stringify({
        output: [{ content: [{ text: JSON.stringify(value), type: 'output_text' }], type: 'message' }],
      }), { status: 200 });
    },
  });
  const conversation = completedConversation([message('m0', 'Maybe linen would work for AQAL.', 0)]);
  const aqal = project('aqal', 'AQAL');

  const matches = await analyzer.matchProjectSegments(conversation, [aqal]);
  const reconciliation = await analyzer.reconcileProjectSegment({
    conversation,
    project: aqal,
    relevantMessageIds: ['m0'],
    snapshot: {
      decisions: [],
      knowledgeItems: [{ content: 'Linen is confirmed.', createdAt: STARTED_AT, id: 'linen', kind: 'fact', projectId: 'aqal', status: 'current', updatedAt: STARTED_AT }],
      recentWorkSessions: [],
      tasks: [],
    },
  });

  assert.equal(matches[0].projectId, 'aqal');
  assert.equal(reconciliation.candidates[0].classification, 'already_known');
  assert.equal(requests[0].text.format.type, 'json_schema');
  assert.equal(requests[0].text.format.strict, true);
  assert.match(requests[0].instructions, /one consolidated match per Project/);
  assert.match(requests[0].instructions, /unique, explicit acronym or shorthand/);
  assert.match(requests[1].input[0].content, /Linen is confirmed/);
  assert.match(requests[1].instructions, /Compare every candidate with current Project state/);
});

test('malformed structured candidates without evidence identities are rejected before persistence', async () => {
  const analyzer = new OpenAIConversationProjectAnalyzer({
    apiKey: 'test-key',
    fetchImplementation: async () => new Response(JSON.stringify({
      output: [{ content: [{ text: JSON.stringify({
        candidates: [{ classification: 'new', content: 'Minimum order is 100.',
          existingEntityId: null, knowledgeKind: 'fact', rationale: null,
          target: 'knowledge', title: null, usefulPending: false }],
        summary: 'Minimum order.', title: 'Order',
      }), type: 'output_text' }], type: 'message' }],
    }), { status: 200 }),
  });
  const conversation = completedConversation([message('m0', 'For AQAL, minimum order is 100.', 0)]);
  await assert.rejects(analyzer.reconcileProjectSegment({
    conversation, project: project('aqal', 'AQAL'), relevantMessageIds: ['m0'],
    snapshot: { decisions: [], knowledgeItems: [], recentWorkSessions: [], tasks: [] },
  }), /invalid candidate/);
});

test('the processing endpoint authenticates first and passes only verified identity to the processor', async () => {
  let processorContext;
  let processedId;
  const request = new Request('https://example.com/api/process-conversation', {
    body: JSON.stringify({ conversationId: 'conversation-1' }),
    headers: {
      [ASSISTANT_CLIENT_HEADER]: ASSISTANT_CLIENT_ID,
      Authorization: 'Bearer valid-token',
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  const response = await handleConversationProjectProcessing(request, {
    allowedOrigin: 'https://example.com',
    createProcessor: (context) => {
      processorContext = context;
      return { process: async (id) => {
        processedId = id;
        return { projectCount: 1, status: 'processed' };
      } };
    },
    verifyAccessToken: async (token) => {
      assert.equal(token, 'valid-token');
      return { id: 'verified-owner' };
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(processorContext, { accessToken: 'valid-token', userId: 'verified-owner' });
  assert.equal(processedId, 'conversation-1');
  assert.deepEqual(await response.json(), { projectCount: 1, status: 'processed' });
});

test('a bounded single-flight wait returns processing instead of marking the conversation failed', async () => {
  const request = new Request('https://example.com/api/process-conversation', {
    body: JSON.stringify({ conversationId: 'conversation-1' }),
    headers: {
      [ASSISTANT_CLIENT_HEADER]: ASSISTANT_CLIENT_ID,
      Authorization: 'Bearer valid-token',
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  const response = await handleConversationProjectProcessing(request, {
    allowedOrigin: 'https://example.com',
    createProcessor: () => ({ process: async () => {
      throw new ConversationProcessingInProgressError('already running');
    } }),
    verifyAccessToken: async () => ({ id: 'verified-owner' }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: 'processing' });
});
