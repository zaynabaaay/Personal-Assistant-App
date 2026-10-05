import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  effectiveMemoryStatus,
  MemoryProcessor,
  reconcileMemoryAnalysis,
} from '../src/services/memory/index.ts';
import { validateMemoryAnalysis } from '../src/services/memory/memory-processor.ts';
import { createMemoryAnalyzerInput } from '../src/server/memory/openai-memory-analyzer.ts';
import { executeAssistantServerTool } from '../src/server/assistant/server-tool-executor.ts';
import { authService } from '../src/services/auth/index.ts';
import {
  MEMORY_DRAIN_LIMITS,
  processConversationMemory,
} from '../src/services/memory/memory-processing-client.ts';
import { finishConversationLifecycle } from '../src/services/conversations/conversation-finish-lifecycle.ts';
import { handleAssistantRequest } from '../api/assistant.ts';

const NOW = '2026-08-21T18:00:00.000Z';

function messageContext(content, id, conversationId = 'conversation-a') {
  return {
    conversationId,
    message: { content, conversationId, id, occurredAt: NOW, position: 20, role: 'user' },
    nearbyMessages: [],
  };
}

function candidate(overrides = {}) {
  return {
    action: 'promote',
    confidence: 0.9,
    content: 'The user prefers bright rooms.',
    layer: 'durable',
    memoryType: 'preference',
    provenance: 'explicit_statement',
    scope: 'general',
    subjectKey: 'lighting:brightness',
    ...overrides,
  };
}

function apply(memories, value, id, conversationId = 'conversation-a') {
  return reconcileMemoryAnalysis(
    memories,
    { candidates: [value], version: 1 },
    messageContext(value.content ?? 'History only.', id, conversationId),
    { createId: () => `memory-${id}`, now: () => new Date(NOW) },
  );
}

test('lease generations fence stale commit and stale failure after takeover', () => {
  const checkpoint = { claimToken: 'lease-1', status: 'processing' };
  const commit = (token) => {
    if (checkpoint.status !== 'processing' || checkpoint.claimToken !== token) {
      throw new Error('stale lease');
    }
    checkpoint.status = 'processed';
  };
  const fail = (token) => {
    if (checkpoint.status === 'processing' && checkpoint.claimToken === token) {
      checkpoint.status = 'failed';
    }
  };

  checkpoint.claimToken = 'lease-2';
  assert.throws(() => commit('lease-1'), /stale lease/);
  commit('lease-2');
  fail('lease-1');
  assert.equal(checkpoint.status, 'processed');
});

test('separate conversations analyzing the same empty subject serialize and reject one stale commit', async () => {
  let version = 0;
  let tail = Promise.resolve();
  const commit = async (conversationId, expectedVersion, content) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      if (version !== expectedVersion) throw new Error(`${conversationId}: stale analysis`);
      await Promise.resolve();
      version += 1;
      return content;
    } finally {
      release();
    }
  };

  const results = await Promise.allSettled([
    commit('conversation-a', 0, 'bright'),
    commit('conversation-b', 0, 'dim'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /stale analysis/);
  assert.equal(version, 1);
});

test('explicit evidence upgrades inference while repeated inference never gains authority', () => {
  let memories = apply([], candidate({
    action: 'ambiguous', confidence: 0.55, content: 'The user may enjoy dim rooms.',
    provenance: 'inferred',
  }), 'inferred');
  memories = apply(memories, candidate({
    action: 'repeat', content: 'The user may enjoy dim rooms.',
    existingMemoryId: memories[0].id, provenance: 'inferred',
  }), 'inferred-repeat');
  assert.equal(memories[0].provenance, 'inferred');
  assert.equal(memories[0].evidenceCount, 2);

  memories = apply(memories, candidate({
    action: 'repeat', content: 'The user may enjoy dim rooms.',
    existingMemoryId: memories[0].id, provenance: 'explicit_statement',
  }), 'explicit-repeat');
  assert.equal(memories[0].provenance, 'explicit_statement');
  assert.equal(memories[0].status, 'current');
});

test('inference cannot supersede explicit truth, while explicit correction supersedes inference', () => {
  const explicit = apply([], candidate(), 'explicit');
  assert.throws(() => apply(explicit, candidate({
    action: 'supersede', content: 'The user prefers dim rooms.',
    existingMemoryId: explicit[0].id, provenance: 'inferred',
  }), 'bad-inference'), /higher-authority/);

  let inferred = apply([], candidate({
    action: 'ambiguous', confidence: 0.55, content: 'The user may prefer dim rooms.',
    provenance: 'inferred',
  }), 'uncertain');
  inferred = apply(inferred, candidate({
    action: 'supersede', content: 'The user definitely loves dim rooms.',
    existingMemoryId: inferred[0].id,
  }), 'explicit-correction');
  assert.deepEqual(inferred.map((memory) => memory.status), ['superseded', 'current']);
  assert.equal(inferred[1].provenance, 'explicit_statement');
});

test('explicit statements cannot supersede decisions but decisions can replace statements', () => {
  const decision = apply([], candidate({
    content: 'The user decided to keep the lights bright.',
    provenance: 'explicit_decision',
  }), 'decision');
  assert.throws(() => apply(decision, candidate({
    action: 'supersede', content: 'The user mentioned preferring dim lights.',
    existingMemoryId: decision[0].id, provenance: 'explicit_statement',
  }), 'lower-statement'), /higher-authority/);

  const statement = apply([], candidate(), 'statement');
  const corrected = apply(statement, candidate({
    action: 'supersede', content: 'The user decided to keep the lights dim.',
    existingMemoryId: statement[0].id, provenance: 'explicit_decision',
  }), 'higher-decision');
  assert.deepEqual(corrected.map((memory) => memory.status), ['superseded', 'current']);
});

test('one explicit correction atomically supersedes every incompatible active row', () => {
  let memories = apply([], candidate(), 'bright');
  memories = apply(memories, candidate({
    action: 'ambiguous', confidence: 0.55, content: 'The user may prefer dim rooms.',
    provenance: 'inferred',
  }), 'dim');
  memories = apply(memories, candidate({
    action: 'supersede', content: 'The user prefers softly lit rooms.',
    existingMemoryId: memories[0].id,
  }), 'soft');

  assert.equal(memories.filter((memory) => memory.status === 'current').length, 1);
  assert.equal(memories.filter((memory) => memory.status === 'superseded').length, 2);
  assert.ok(memories.slice(0, 2).every((memory) =>
    memory.supersededByMemoryId === 'memory-soft'));
});

test('delayed pronoun and lexical-change clarification can reconcile bounded unresolved memory', () => {
  let memories = apply([], candidate({
    action: 'ambiguous', confidence: 0.55, content: 'The user may be warming to dim rooms.',
    provenance: 'inferred',
  }), 'maybe', 'conversation-early');
  memories = apply(memories, candidate({
    action: 'supersede', content: 'The user definitely loves low lighting.',
    existingMemoryId: memories[0].id,
  }), 'them', 'conversation-later');
  assert.equal(memories[0].status, 'superseded');
  assert.equal(memories[1].content, 'The user definitely loves low lighting.');
  assert.equal(memories[1].provenance, 'explicit_statement');
});

test('History-only brainstorming stays non-authoritative until a later clear decision', () => {
  let memories = apply([], { action: 'history_only', confidence: 0 }, 'brainstorm');
  assert.deepEqual(memories, []);
  memories = apply(memories, candidate({
    content: 'The user decided to enroll in a ceramics workshop.',
    memoryType: 'commitment', provenance: 'explicit_decision',
    subjectKey: 'learning:ceramics-workshop',
  }), 'decision');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].provenance, 'explicit_decision');
});

test('temporal currentness excludes future, stale, and expired rows and supplies review bounds', () => {
  const baseMemory = apply([], candidate(), 'temporal')[0];
  const at = new Date(NOW);
  assert.equal(effectiveMemoryStatus({ ...baseMemory, validFrom: '2026-08-22T00:00:00Z' }, at), 'stale');
  assert.equal(effectiveMemoryStatus({ ...baseMemory, staleAfter: '2026-08-20T00:00:00Z' }, at), 'stale');
  assert.equal(effectiveMemoryStatus({ ...baseMemory, validUntil: '2026-08-20T00:00:00Z' }, at), 'expired');

  const bounded = validateMemoryAnalysis({ candidates: [candidate({
    action: 'exception', context: 'this evening', layer: 'current_state', memoryType: 'state',
  })], version: 1 }, [], { sourceOccurredAt: NOW });
  assert.equal(bounded.candidates[0].staleAfter, '2026-08-28T18:00:00.000Z');
  const invalid = validateMemoryAnalysis({ candidates: [candidate({
    layer: 'current_state', validFrom: '2026-09-01T00:00:00Z',
    validUntil: '2026-08-01T00:00:00Z',
  })], version: 1 }, [], { sourceOccurredAt: NOW });
  assert.deepEqual(invalid.candidates, []);
});

test('Project-scoped candidates are forced to History-only before commit', () => {
  const analysis = validateMemoryAnalysis({ candidates: [candidate({
    content: 'AQAL uses linen packaging.', scope: 'project', subjectKey: 'aqal:packaging',
  })], version: 1 }, []);
  assert.deepEqual(analysis.candidates, [{ action: 'history_only', confidence: 0 }]);
});

test('named Project content is rejected even when the analyzer mislabels it general', () => {
  const projects = [{ id: 'project-aqal', name: 'AQAL', status: 'active' }];
  const obvious = validateMemoryAnalysis({ candidates: [candidate({
    content: 'AQAL uses linen packaging.', scope: 'general', subjectKey: 'aqal:packaging',
  })], version: 1 }, [], { projectIdentities: projects });
  assert.deepEqual(obvious.candidates, [{ action: 'history_only', confidence: 0 }]);

  const unrelated = validateMemoryAnalysis({ candidates: [candidate({
    content: 'The user likes balanced lighting at home.', scope: 'general',
    subjectKey: 'home:lighting',
  })], version: 1 }, [], { projectIdentities: [
    { id: 'project-lighting', name: 'Lighting', status: 'active' },
  ] });
  assert.equal(unrelated.candidates.length, 1);
  assert.equal(unrelated.candidates[0].action, 'promote');
});

test('the real processor post-analysis path forces a mislabelled named Project candidate History-only', async () => {
  const context = messageContext('AQAL uses linen packaging.', 'project-guard');
  let committed;
  let complete = false;
  const processor = new MemoryProcessor({ analyze: async () => ({ candidates: [candidate({
    content: 'AQAL uses linen packaging.', scope: 'general', subjectKey: 'aqal:packaging',
  })], version: 1 }) }, {
    claimNextMessage: async () => complete ? { status: 'complete' } : {
      claimToken: 'project-guard-token', context, status: 'claimed',
    },
    commitAnalysis: async (input) => { committed = input.analysis; complete = true; },
    failMessage: async () => undefined,
    getAnalysisMemories: async () => [],
    getProjectIdentities: async () => [{ id: 'project-aqal', name: 'AQAL', status: 'active' }],
    search: async () => [],
  });
  await processor.process('conversation-a');
  assert.deepEqual(committed.candidates, [{ action: 'history_only', confidence: 0 }]);
});

test('analyzer input remains deterministic and below its ceiling with oversized context', () => {
  const memory = apply([], candidate(), 'oversized')[0];
  const serialized = createMemoryAnalyzerInput({
    context: {
      ...messageContext('x'.repeat(9_000), 'oversized-source'),
      nearbyMessages: Array.from({ length: 20 }, (_, index) => ({
        content: String(index).repeat(4_000), id: `near-${index}`,
        occurredAt: NOW, position: index, role: index % 2 ? 'assistant' : 'user',
      })),
    },
    existingMemories: Array.from({ length: 30 }, (_, index) => ({
      ...memory, content: `memory-${index}-${'m'.repeat(1_000)}`, id: `memory-${index}`,
    })),
    projectIdentities: Array.from({ length: 20 }, (_, index) => ({
      description: 'd'.repeat(1_000), goal: 'g'.repeat(1_000), id: `project-${index}`,
      name: 'n'.repeat(500), status: 'active',
    })),
  });
  const payload = JSON.parse(serialized);
  assert.ok(serialized.length <= 32_000);
  assert.equal(payload.localEvidence.currentUserMessage.content.length, 4_000);
  assert.ok(payload.localEvidence.nearbyMessages.length <= 7);
  assert.ok(payload.existingMemories.length <= 12);
  assert.ok(payload.projectIdentities.length <= 8);
});

test('central server router independently dispatches search_general_memory', async () => {
  let dispatched = false;
  const call = {
    arguments: { includeUncertain: false, layer: 'any', query: 'lighting' },
    callId: 'memory-router-call', execution: 'server', name: 'search_general_memory',
  };
  const output = await executeAssistantServerTool(call, { accessToken: 'token', userId: 'owner' }, {
    history: async () => { throw new Error('History must not receive memory calls.'); },
    memory: async (received) => {
      dispatched = received === call;
      return { ...call, result: { memories: [], status: 'success', truncated: false } };
    },
    project: async () => { throw new Error('Project must not receive memory calls.'); },
    projectWrite: async () => { throw new Error('Project writes must not receive memory calls.'); },
  });
  assert.equal(dispatched, true);
  assert.equal(output.name, 'search_general_memory');
});

test('assistant server tool loop reaches memory through the central router', async () => {
  let providerCalls = 0;
  let routedCalls = 0;
  const executors = {
    history: async () => { throw new Error('wrong route'); },
    memory: async (call) => {
      routedCalls += 1;
      return {
        callId: call.callId, execution: 'server', name: call.name,
        result: { memories: [], status: 'success', truncated: false },
      };
    },
    project: async () => { throw new Error('wrong route'); },
    projectWrite: async () => { throw new Error('wrong route'); },
  };
  const request = new Request('https://example.com/api/assistant', {
    body: JSON.stringify({
      context: {
        currentLocalDate: 'August 21, 2026', currentLocalTime: '2:00 PM',
        dayOfWeek: 'Friday', timezone: 'America/Toronto',
      },
      messages: [{ content: 'What lighting do I like?', role: 'user' }],
      sessionId: 'memory-router-session',
    }),
    headers: {
      Authorization: 'Bearer valid-token', 'Content-Type': 'application/json',
      Origin: 'https://example.com',
    },
    method: 'POST',
  });
  const response = await handleAssistantRequest(request, {
    allowedOrigin: 'https://example.com',
    apiKey: 'test-key',
    executeServerTool: (call, context) => executeAssistantServerTool(call, context, executors),
    fetchImplementation: async (_url, init) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return new Response(JSON.stringify({ output: [{
          arguments: JSON.stringify({ includeUncertain: false, layer: 'any', query: 'lighting' }),
          call_id: 'memory-loop-call', name: 'search_general_memory', type: 'function_call',
        }] }), { headers: { 'Content-Type': 'application/json' } });
      }
      const body = JSON.parse(String(init.body));
      assert.equal(body.input.at(-1).type, 'function_call_output');
      return new Response(JSON.stringify({ output: [{
        content: [{ text: 'I do not have a current lighting preference.', type: 'output_text' }],
        type: 'message',
      }] }), { headers: { 'Content-Type': 'application/json' } });
    },
    verifyAccessToken: async () => ({ id: 'owner-a' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'completed');
  assert.equal(routedCalls, 1);
  assert.equal(providerCalls, 2);
});

test('Project current truth wins when the assistant tool loop sees conflicting general memory', async () => {
  let providerCalls = 0;
  const project = {
    id: 'project-aqal', name: 'AQAL', priority: 'high', status: 'active',
    timezone: 'America/Toronto', type: 'business', updatedAt: NOW,
  };
  const executors = {
    history: async () => { throw new Error('wrong route'); },
    memory: async (call) => ({
      callId: call.callId, execution: 'server', name: call.name,
      result: {
        memories: [{
          confidence: 0.9, content: 'The user generally prefers paper packaging.', evidenceCount: 1,
          id: 'memory-packaging', lastConfirmedAt: NOW, layer: 'durable', memoryType: 'preference',
          provenance: 'explicit_statement', sourceReferences: [{
            conversationId: 'general-chat', messageId: 'general-message', occurredAt: NOW, role: 'user',
          }], status: 'current', subjectKey: 'packaging:material', updatedAt: NOW,
        }],
        status: 'success', truncated: false,
      },
    }),
    project: async (call) => ({
      callId: call.callId, execution: 'server', name: call.name,
      result: {
        currentDecisions: [{ decidedAt: NOW, id: 'decision-packaging', statement: 'AQAL uses linen packaging.' }],
        focus: 'knowledge', project, status: 'success', truncatedSections: [],
      },
    }),
    projectWrite: async () => { throw new Error('writes are out of scope'); },
  };
  const response = await handleAssistantRequest(new Request('https://example.com/api/assistant', {
    body: JSON.stringify({
      context: { currentLocalDate: 'August 21, 2026', currentLocalTime: '2:00 PM', dayOfWeek: 'Friday', timezone: 'America/Toronto' },
      messages: [{ content: 'What packaging does AQAL use?', role: 'user' }],
      sessionId: 'project-memory-conflict',
    }),
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json', Origin: 'https://example.com' },
    method: 'POST',
  }), {
    allowedOrigin: 'https://example.com', apiKey: 'test-key',
    executeServerTool: (call, context) => executeAssistantServerTool(call, context, executors),
    fetchImplementation: async (_url, init) => {
      providerCalls += 1;
      if (providerCalls === 1) return new Response(JSON.stringify({ output: [
        { arguments: JSON.stringify({ includeUncertain: false, layer: 'durable', query: 'packaging material' }), call_id: 'memory-conflict', name: 'search_general_memory', type: 'function_call' },
        { arguments: JSON.stringify({ focus: 'knowledge', projectId: 'project-aqal' }), call_id: 'project-conflict', name: 'get_project_context', type: 'function_call' },
      ] }), { headers: { 'Content-Type': 'application/json' } });
      const body = JSON.parse(String(init.body));
      const evidence = body.input.filter((item) => item.type === 'function_call_output')
        .map((item) => item.output).join(' ');
      assert.match(evidence, /paper packaging/);
      assert.match(evidence, /AQAL uses linen packaging/);
      assert.match(body.instructions, /Project state wins for Project-specific truth/);
      return new Response(JSON.stringify({ output: [{
        content: [{ text: 'AQAL uses linen packaging.', type: 'output_text' }], type: 'message',
      }] }), { headers: { 'Content-Type': 'application/json' } });
    },
    verifyAccessToken: async () => ({ id: 'owner-a' }),
  });
  assert.deepEqual(await response.json(), { content: 'AQAL uses linen packaging.', status: 'completed' });
});

test('database contract contains lease fencing, subject serialization, stale snapshots, and validity guards', async () => {
  const migration = await readFile(new URL(
    '../supabase/migrations/20260821180000_create_general_memory.sql', import.meta.url,
  ), 'utf8');
  assert.match(migration, /claim_token text not null/);
  assert.match(migration, /status = 'processing' and claim_token = p_claim_token/);
  assert.match(migration, /checkpoint\.claim_token is distinct from p_claim_token/);
  assert.match(migration, /memory-subject:/);
  assert.match(migration, /Memory analysis is stale and must be retried/);
  assert.match(migration, /canonical_general_memory_identity/);
  assert.match(migration, /general_memory_provenance_rank\(provenance\) > candidate_provenance_rank/);
  assert.match(migration, /superseded_by_memory_id = candidate_id[\s\S]*subject_identity = candidate_subject/);
  assert.match(migration, /valid_until >= valid_from/);
  assert.match(migration, /layer <> 'current_state' or valid_until is not null or stale_after is not null/);
  assert.match(migration, /valid_from > now\(\) then 'stale'/);
  assert.match(migration, /create function public\.get_memory_analysis_context/);
  assert.doesNotMatch(migration, /(insert into|update) public\.project_/i);
});

test('a client drain discovers a backlog larger than the former 32-message window', async () => {
  const originalGetAccessToken = authService.getAccessToken;
  const originalFetch = globalThis.fetch;
  let requests = 0;
  authService.getAccessToken = async () => 'memory-token';
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({
      status: requests <= 5 ? 'partial' : 'processed',
    }), { status: requests <= 5 ? 202 : 200 });
  };
  try {
    assert.deepEqual(await processConversationMemory('large-backlog'), { status: 'processed' });
    assert.equal(requests, 6);
    assert.ok(MEMORY_DRAIN_LIMITS.requests * 8 > 32);
  } finally {
    authService.getAccessToken = originalGetAccessToken;
    globalThis.fetch = originalFetch;
  }
});

test('a later bounded continuation resumes after the 256-message execution ceiling', async () => {
  const originalGetAccessToken = authService.getAccessToken;
  const originalFetch = globalThis.fetch;
  let requests = 0;
  authService.getAccessToken = async () => 'memory-token';
  globalThis.fetch = async () => {
    requests += 1;
    const complete = requests === MEMORY_DRAIN_LIMITS.requests + 2;
    return new Response(JSON.stringify({ status: complete ? 'processed' : 'partial' }), {
      status: complete ? 200 : 202,
    });
  };
  try {
    assert.deepEqual(await processConversationMemory('large-completed'), { status: 'processing' });
    assert.equal(requests, MEMORY_DRAIN_LIMITS.requests);
    assert.deepEqual(await processConversationMemory(), { status: 'processed' });
    assert.equal(requests, MEMORY_DRAIN_LIMITS.requests + 2);
  } finally {
    authService.getAccessToken = originalGetAccessToken;
    globalThis.fetch = originalFetch;
  }
});

test('Finish triggers retry after persistence without letting memory failure block reset or Project work', async () => {
  const completed = {
    conversation: { id: 'finished-conversation' },
    messages: [{ id: 'message-1' }],
  };
  const events = [];
  const result = await finishConversationLifecycle({
    active: { id: 'finished-conversation' },
    onPersisted: () => events.push('persisted'),
    process: async () => { events.push('project'); return { status: 'processed' }; },
    processMemory: async () => { events.push('memory'); throw new Error('retry later'); },
    reset: () => events.push('reset'),
    service: { finishConversation: async () => completed },
  });
  await Promise.resolve();
  assert.equal(result.processingStatus, 'processed');
  assert.deepEqual(events.slice(0, 2), ['reset', 'persisted']);
  assert.ok(events.includes('memory'));
  assert.ok(events.includes('project'));
});

test('an earlier extraction failure is retried successfully after Finish', async () => {
  let attempts = 0;
  const extract = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary analyzer failure');
  };
  await assert.rejects(extract(), /temporary analyzer failure/);
  await finishConversationLifecycle({
    active: { id: 'retry-after-finish' },
    process: async () => ({ status: 'processed' }),
    processMemory: extract,
    reset: () => undefined,
    service: {
      finishConversation: async () => ({ conversation: { id: 'retry-after-finish' }, messages: [] }),
    },
  });
  await Promise.resolve();
  assert.equal(attempts, 2);
});

test('duplicate Finish memory retries remain safe and independently resumable', async () => {
  const completed = { conversation: { id: 'duplicate-finish' }, messages: [] };
  let memoryAttempts = 0;
  const options = {
    active: { id: 'duplicate-finish' },
    process: async () => ({ status: 'already_processed' }),
    processMemory: async () => { memoryAttempts += 1; },
    reset: () => undefined,
    service: { finishConversation: async () => completed },
  };
  await finishConversationLifecycle(options);
  await finishConversationLifecycle(options);
  await Promise.resolve();
  assert.equal(memoryAttempts, 2);
});
