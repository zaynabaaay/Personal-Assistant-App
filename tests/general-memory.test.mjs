import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { MemoryProcessor, reconcileMemoryAnalysis } from '../src/services/memory/index.ts';
import { validateMemoryAnalysis } from '../src/services/memory/memory-processor.ts';
import { createAssistantMemoryToolExecutor } from '../src/server/assistant/memory-tool-executor.ts';
import { handleMemoryProcessing } from '../src/server/memory/memory-processing-handler.ts';

const TIME = '2026-08-21T12:00:00.000Z';

function context(content, id = `message-${Math.random()}`) {
  return {
    conversationId: 'conversation-1',
    message: { content, conversationId: 'conversation-1', id, occurredAt: TIME, position: 0, role: 'user' },
    nearbyMessages: [{ content, id, occurredAt: TIME, position: 0, role: 'user' }],
  };
}

function candidate(overrides = {}) {
  return {
    action: 'promote',
    confidence: 0.95,
    content: 'The user dislikes mushrooms.',
    layer: 'durable',
    memoryType: 'preference',
    provenance: 'explicit_statement',
    subjectKey: 'food:mushrooms',
    topic: 'food preferences',
    ...overrides,
  };
}

function apply(memories, content, candidates, id) {
  const messageContext = context(content, id);
  const analysis = validateMemoryAnalysis({ candidates, version: 1 }, memories);
  return reconcileMemoryAnalysis(memories, analysis, messageContext, {
    createId: (index) => `${id}:memory:${index}`,
    now: () => new Date(TIME),
  });
}

test('an explicit durable preference is saved automatically with source evidence', () => {
  const memories = apply([], "I don't like mushrooms.", [candidate()], 'preference-1');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].layer, 'durable');
  assert.equal(memories[0].memoryType, 'preference');
  assert.equal(memories[0].provenance, 'explicit_statement');
  assert.deepEqual(memories[0].sourceReferences.map((source) => source.messageId), ['preference-1']);
});

test('a repeated preference strengthens the existing memory without duplication', () => {
  let memories = apply([], "I don't like mushrooms.", [candidate()], 'repeat-1');
  memories = apply(memories, 'Mushrooms are still not for me.', [candidate({
    action: 'repeat', existingMemoryId: memories[0].id,
  })], 'repeat-2');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].evidenceCount, 2);
  assert.equal(memories[0].sourceReferences.length, 2);
});

test('a clear preference correction supersedes while preserving provenance links', () => {
  let memories = apply([], "I don't like mushrooms.", [candidate()], 'correction-1');
  memories = apply(memories, 'I actually like mushrooms now.', [candidate({
    action: 'supersede', content: 'The user likes mushrooms.', existingMemoryId: memories[0].id,
  })], 'correction-2');
  assert.equal(memories.length, 2);
  assert.equal(memories[0].status, 'superseded');
  assert.equal(memories[1].status, 'current');
  assert.equal(memories[1].supersedesMemoryId, memories[0].id);
  assert.equal(memories[0].supersededByMemoryId, memories[1].id);
});

test('a situation-specific exception does not reverse a general preference', () => {
  let memories = apply([], "I don't like mushrooms.", [candidate()], 'exception-1');
  memories = apply(memories, 'I want mushrooms tonight.', [candidate({
    action: 'exception', content: 'The user wants mushrooms for tonight’s meal.',
    context: 'tonight’s meal', layer: 'current_state', memoryType: 'state',
    subjectKey: 'meal:tonight:mushrooms', staleAfter: '2026-08-22T12:00:00.000Z',
  })], 'exception-2');
  assert.equal(memories.length, 2);
  assert.equal(memories[0].status, 'current');
  assert.equal(memories[0].content, 'The user dislikes mushrooms.');
  assert.equal(memories[1].context, 'tonight’s meal');
});

test('compatible contextual preferences coexist', () => {
  let memories = apply([], 'I like exercising in the morning.', [candidate({
    content: 'The user prefers exercising in the morning.', subjectKey: 'exercise:timing',
    topic: 'exercise',
  })], 'coexist-1');
  memories = apply(memories, 'On Thursdays I prefer going after work.', [candidate({
    action: 'coexist', content: 'The user prefers exercising after work on Thursdays.',
    context: 'Thursdays', subjectKey: 'exercise:timing', topic: 'exercise',
  })], 'coexist-2');
  assert.equal(memories.filter((memory) => memory.status === 'current').length, 2);
});

test('inventory is current-state memory and a later quantity supersedes it', () => {
  let memories = apply([], 'I have three bananas left.', [candidate({
    content: 'The user has three bananas left.', layer: 'current_state', memoryType: 'state',
    subjectKey: 'inventory:bananas', topic: 'household inventory', staleAfter: '2026-08-28T12:00:00.000Z',
  })], 'inventory-1');
  assert.equal(memories[0].layer, 'current_state');
  memories = apply(memories, 'I used one, so there are two bananas left.', [candidate({
    action: 'supersede', content: 'The user has two bananas left.', existingMemoryId: memories[0].id,
    layer: 'current_state', memoryType: 'state', subjectKey: 'inventory:bananas',
  })], 'inventory-2');
  assert.deepEqual(memories.map((memory) => memory.status), ['superseded', 'current']);
});

test('weak brainstorming and random factual questions remain History-only', () => {
  const pottery = apply([], 'Maybe I should learn pottery someday.', [
    { action: 'history_only', confidence: 0 },
  ], 'history-1');
  const factual = apply(pottery, 'How tall is Mount Kilimanjaro?', [
    { action: 'history_only', confidence: 0 },
  ], 'history-2');
  assert.deepEqual(factual, []);
});

test('a later explicit commitment is promoted after earlier brainstorming was not', () => {
  let memories = apply([], 'Maybe I should learn pottery someday.', [
    { action: 'history_only', confidence: 0 },
  ], 'promotion-1');
  memories = apply(memories, "I've decided to take a pottery class this fall.", [candidate({
    content: 'The user decided to take a pottery class this fall.', layer: 'current_state',
    memoryType: 'commitment', provenance: 'explicit_decision', subjectKey: 'learning:pottery-class',
    topic: 'learning', validUntil: '2026-12-01T00:00:00.000Z',
  })], 'promotion-2');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].provenance, 'explicit_decision');
});

test('inferred memory is capped below explicit evidence authority', () => {
  const analysis = validateMemoryAnalysis({ candidates: [candidate({
    confidence: 0.98, content: 'The user seems to favor quiet spaces.',
    provenance: 'inferred', subjectKey: 'environment:quiet',
  })], version: 1 }, []);
  assert.equal(analysis.candidates[0].confidence, 0.65);
});

test('ambiguous change is retained without superseding current memory', () => {
  let memories = apply([], 'I prefer bright rooms.', [candidate({
    content: 'The user prefers bright rooms.', subjectKey: 'lighting:brightness',
  })], 'ambiguous-1');
  memories = apply(memories, 'Maybe dim rooms are growing on me.', [candidate({
    action: 'ambiguous', content: 'The user may be warming to dim rooms.', confidence: 0.55,
    existingMemoryId: memories[0].id, provenance: 'inferred', subjectKey: 'lighting:brightness',
  })], 'ambiguous-2');
  assert.equal(memories[0].status, 'current');
  assert.equal(memories[1].status, 'ambiguous');
});

test('processor is bounded, idempotent, and retrieves structured memory without History scan', async () => {
  const messageContext = context('I prefer paper notebooks.', 'processor-1');
  let memories = [];
  let processed = false;
  let searchCalls = 0;
  const repository = {
    claimNextMessage: async () => processed ? { status: 'complete' } : {
      claimToken: 'claim-token-processor-1', context: messageContext, status: 'claimed',
    },
    commitAnalysis: async ({ analysis }) => {
      memories = reconcileMemoryAnalysis(memories, analysis, messageContext, { createId: () => 'memory-1' });
      processed = true;
    },
    failMessage: async () => undefined,
    getAnalysisMemories: async () => { searchCalls += 1; return memories; },
    getProjectIdentities: async () => [],
    search: async () => memories,
  };
  const analyzer = { analyze: async () => ({ candidates: [candidate({
    content: 'The user prefers paper notebooks.', subjectKey: 'notes:medium',
  })], version: 1 }) };
  const processor = new MemoryProcessor(analyzer, repository);
  await processor.process('conversation-1');
  await processor.process('conversation-1');
  assert.equal(memories.length, 1);
  assert.equal(searchCalls, 1);
});

test('assistant retrieves bounded structured memory with traceable evidence', async () => {
  const stored = apply([], 'I prefer paper notebooks.', [candidate({
    content: 'The user prefers paper notebooks.', subjectKey: 'notes:medium',
  })], 'retrieval-1')[0];
  let receivedOptions;
  const execute = createAssistantMemoryToolExecutor(() => ({
    search: async (_query, options) => { receivedOptions = options; return [stored]; },
  }));
  const output = await execute({
    arguments: { includeUncertain: false, layer: 'durable', query: 'note-taking preference' },
    callId: 'memory-call-1', execution: 'server', name: 'search_general_memory',
  }, { accessToken: 'token-a', userId: 'owner-a' });
  assert.equal(output.result.status, 'success');
  assert.equal(output.result.memories[0].sourceReferences[0].messageId, 'retrieval-1');
  assert.equal(receivedOptions.layer, 'durable');
});

test('memory processing ownership comes only from verified authentication', async () => {
  let processorContext;
  const request = new Request('https://example.com/api/process-memory', {
    body: JSON.stringify({ conversationId: 'conversation-1', ownerId: 'owner-b' }),
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json', Origin: 'https://example.com' },
    method: 'POST',
  });
  const response = await handleMemoryProcessing(request, {
    allowedOrigin: 'https://example.com',
    createProcessor: (value) => {
      processorContext = value;
      return { process: async () => ({ processedMessageCount: 1, status: 'processed' }) };
    },
    verifyAccessToken: async () => ({ id: 'owner-a' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(processorContext, { accessToken: 'valid', userId: 'owner-a' });
});

test('migration derives ownership, enforces RLS, and cannot write Project tables', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20260821180000_create_general_memory.sql', import.meta.url), 'utf8');
  assert.match(migration, /create table public\.general_memories/);
  assert.match(migration, /create table public\.memory_message_processing/);
  assert.match(migration, /enable row level security/g);
  assert.match(migration, /authenticated_owner uuid := auth\.uid\(\)/);
  assert.match(migration, /owner_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /revoke all on table public\.general_memories from public, anon, authenticated/);
  assert.doesNotMatch(migration, /service_role/);
  assert.doesNotMatch(migration, /(insert into|update) public\.project_/i);
});

test('active durability and automatic capture remain ordered: persist before processing', async () => {
  const home = await readFile(new URL('../src/features/home/home-screen.tsx', import.meta.url), 'utf8');
  const persisted = home.indexOf('persistedUserConversation = await persistActiveConversation');
  const processing = home.indexOf('processConversationMemory(persistedUserConversation.id)');
  const response = home.indexOf('assistantService.respond', processing);
  assert.ok(persisted >= 0 && processing > persisted && response > processing);
  assert.match(home, /processConversationMemory\(stored\?\.id\).*catch/s);
});

test('assistant hierarchy keeps Project truth authoritative and raw History available', async () => {
  const provider = await readFile(new URL('../src/server/assistant/openai-assistant-provider.ts', import.meta.url), 'utf8');
  assert.match(provider, /Project state wins for Project-specific truth/);
  assert.match(provider, /completed-conversation History for what was said, suggested, or discussed/);
  assert.match(provider, /Never ask whether to save, add, or remember ordinary memory/);
});
