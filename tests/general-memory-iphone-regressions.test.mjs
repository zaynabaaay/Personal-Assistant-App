import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAssistantRequest } from '../api/assistant.ts';
import { MemoryProcessor, reconcileMemoryAnalysis } from '../src/services/memory/index.ts';
import {
  isDeterministicMemoryCommitFailure,
  validateMemoryAnalysis,
} from '../src/services/memory/memory-processor.ts';
import {
  createAssistantMemoryToolExecutor,
  MEMORY_USEFUL_RELEVANCE_THRESHOLD,
} from '../src/server/assistant/memory-tool-executor.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TIME = '2026-08-25T12:00:00.000Z';

function request(message) {
  return new Request('https://example.com/api/assistant', {
    body: JSON.stringify({
      context: {
        currentLocalDate: 'August 25, 2026', currentLocalTime: '8:00 AM',
        dayOfWeek: 'Tuesday', timezone: 'America/Toronto',
      },
      messages: [{ content: message, role: 'user' }],
      sessionId: `iphone-${message}`,
    }),
    headers: {
      Authorization: 'Bearer valid', 'Content-Type': 'application/json',
      Origin: 'https://example.com',
    },
    method: 'POST',
  });
}

function openAIOutput(output) {
  return new Response(JSON.stringify({ output }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function toolCall(name, callId, args) {
  return { arguments: JSON.stringify(args), call_id: callId, name, type: 'function_call' };
}

function assistantText(text) {
  return { content: [{ text, type: 'output_text' }], type: 'message' };
}

function memoryItem(overrides = {}) {
  return {
    confidence: 0.99,
    content: 'Prefers matte ceramic mugs over glossy ones.',
    evidenceCount: 1,
    id: 'memory-mugs',
    lastConfirmedAt: TIME,
    layer: 'durable',
    memoryType: 'preference',
    provenance: 'explicit_statement',
    sourceReferences: [{
      conversationId: 'source-chat', messageId: 'source-message', occurredAt: TIME, role: 'user',
    }],
    status: 'current',
    subjectKey: 'mug-material-finish-preference',
    updatedAt: TIME,
    ...overrides,
  };
}

async function runRoutingScenario({ message, responses, executeServerTool, traces = [] }) {
  let providerCalls = 0;
  const response = await handleAssistantRequest(request(message), {
    allowedOrigin: 'https://example.com',
    apiKey: 'test-key',
    executeServerTool,
    fetchImplementation: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      const next = responses[providerCalls];
      providerCalls += 1;
      return typeof next === 'function' ? next(body) : next;
    },
    logMemoryRouting: (metadata) => traces.push(metadata),
    verifyAccessToken: async () => ({ id: OWNER }),
  });
  return { body: await response.json(), providerCalls, status: response.status };
}

test('iPhone mug first-pass recall invokes general memory and answers without a History cue', async () => {
  const calls = [];
  const mug = memoryItem();
  const result = await runRoutingScenario({
    executeServerTool: async (call) => {
      calls.push(call);
      return {
        callId: call.callId, execution: 'server', name: call.name,
        result: { memories: [mug], status: 'success', truncated: false },
      };
    },
    message: 'What kind of mugs do I prefer?',
    responses: [
      openAIOutput([toolCall('search_general_memory', 'mug-memory', {
        includeUncertain: false, layer: 'durable', query: 'mug preference',
      })]),
      (body) => {
        assert.match(body.input.at(-1).output, /matte ceramic mugs over glossy/);
        return openAIOutput([assistantText('You prefer matte ceramic mugs, not glossy ones.')]);
      },
    ],
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.content, 'You prefer matte ceramic mugs, not glossy ones.');
  assert.deepEqual(calls.map((call) => call.name), ['search_general_memory']);
});

test('iPhone umbrella direct recall invokes current-state general memory automatically', async () => {
  const calls = [];
  const umbrella = memoryItem({
    content: 'Currently has a blue umbrella borrowed from a cousin.',
    id: 'memory-umbrella', layer: 'current_state', memoryType: 'state',
    subjectKey: 'borrowed-blue-umbrella-in-possession',
  });
  const result = await runRoutingScenario({
    executeServerTool: async (call) => {
      calls.push(call);
      return {
        callId: call.callId, execution: 'server', name: call.name,
        result: { memories: [umbrella], status: 'success', truncated: false },
      };
    },
    message: 'Do I still have my cousins umbrella',
    responses: [
      openAIOutput([toolCall('search_general_memory', 'umbrella-memory', {
        includeUncertain: false, layer: 'current_state', query: 'cousin umbrella',
      })]),
      openAIOutput([assistantText('Yes — you still have the blue umbrella you borrowed from your cousin.')]),
    ],
  });
  assert.equal(result.body.content,
    'Yes — you still have the blue umbrella you borrowed from your cousin.');
  assert.deepEqual(calls.map((call) => call.name), ['search_general_memory']);
});

test('direct personal recall automatically falls back to completed History after empty memory', async () => {
  const calls = [];
  const traces = [];
  const result = await runRoutingScenario({
    executeServerTool: async (call) => {
      calls.push(call.name);
      if (call.name === 'search_general_memory') {
        return {
          callId: call.callId, execution: 'server', name: call.name,
          result: { memories: [], status: 'success', truncated: false },
        };
      }
      return {
        callId: call.callId, execution: 'server', name: call.name,
        result: {
          matches: [{
            completedAt: TIME, conversationId: 'umbrella-history', relevance: 0.9,
            messages: [{
              content: 'I borrowed a blue umbrella from my cousin, and I still have it with me',
              occurredAt: TIME, role: 'user',
            }],
          }],
          status: 'success', truncated: false,
        },
      };
    },
    message: 'Do I still have my cousins umbrella',
    responses: [
      openAIOutput([toolCall('search_general_memory', 'empty-memory', {
        includeUncertain: false, layer: 'current_state', query: 'cousin umbrella',
      })]),
      (body) => {
        assert.match(body.input.at(-1).output, /"memories":\[\]/);
        return openAIOutput([toolCall('search_completed_conversations', 'history-fallback', {
          preferredRole: 'user', query: 'cousin umbrella', recencyBias: 'recent',
        })]);
      },
      openAIOutput([assistantText('Yes — you said you still had your cousin’s blue umbrella.')]),
    ],
    traces,
  });
  assert.equal(result.body.content, 'Yes — you said you still had your cousin’s blue umbrella.');
  assert.deepEqual(calls, ['search_general_memory', 'search_completed_conversations']);
  assert.equal(traces[0].historyFallbackRan, true);
  assert.deepEqual(traces[0].tools.map((tool) => [tool.tool, tool.resultCount]), [
    ['search_general_memory', 0], ['search_completed_conversations', 1],
  ]);
  assert.equal(JSON.stringify(traces).includes('cousin umbrella'), false);
  assert.match(traces[0].tools[0].query.fingerprint, /^[0-9a-f]{8}$/);
});

test('irrelevant nonzero memory results do not suppress personal-recall History fallback', async () => {
  const calls = [];
  const traces = [];
  const distractors = Array.from({ length: 5 }, (_, index) => memoryItem({
    content: `Unrelated preference ${index}.`, id: `irrelevant-${index}`,
    relevance: MEMORY_USEFUL_RELEVANCE_THRESHOLD - 0.5,
    subjectKey: `unrelated-preference-${index}`,
  }));
  const executeMemory = createAssistantMemoryToolExecutor(() => ({
    search: async () => distractors,
  }));
  const result = await runRoutingScenario({
    executeServerTool: async (call, context) => {
      calls.push(call.name);
      if (call.name === 'search_general_memory') return executeMemory(call, context);
      return {
        callId: call.callId, execution: 'server', name: call.name,
        result: {
          matches: [{
            completedAt: TIME, conversationId: 'linen-history', relevance: 0.95,
            messages: [{
              content: 'I’m not sure how I feel about linen lampshades. Maybe they’re growing on me.',
              occurredAt: TIME, role: 'user',
            }, {
              content: 'Actually, I definitely love them now.', occurredAt: TIME, role: 'user',
            }],
          }],
          status: 'success', truncated: false,
        },
      };
    },
    message: 'How do I feel about linen lampshades?',
    responses: [
      openAIOutput([toolCall('search_general_memory', 'linen-memory-low-relevance', {
        includeUncertain: false, layer: 'durable', query: 'linen lampshades preference',
      })]),
      (body) => {
        assert.match(body.input.at(-1).output, /"useful":false/);
        return openAIOutput([toolCall('search_completed_conversations', 'linen-history-fallback', {
          preferredRole: 'user', query: 'linen lampshades', recencyBias: 'neutral',
        })]);
      },
      openAIOutput([assistantText('You said you definitely love linen lampshades now.')]),
    ],
    traces,
  });
  assert.equal(result.body.content, 'You said you definitely love linen lampshades now.');
  assert.deepEqual(calls, ['search_general_memory', 'search_completed_conversations']);
  assert.equal(traces[0].historyFallbackRan, true);
  assert.equal(traces[0].tools[0].resultCount, 5);
  assert.equal(traces[0].tools[0].useful, false);
});

test('one useful linen memory answers fresh recall without unnecessary History fallback', async () => {
  const calls = [];
  const traces = [];
  const linen = memoryItem({
    content: 'Loves linen lampshades.', id: 'memory-linen-lampshades',
    relevance: MEMORY_USEFUL_RELEVANCE_THRESHOLD,
    subjectKey: 'linen-lampshade-preference', topic: 'home decor',
  });
  const executeMemory = createAssistantMemoryToolExecutor(() => ({ search: async () => [linen] }));
  const result = await runRoutingScenario({
    executeServerTool: async (call, context) => {
      calls.push(call.name);
      assert.equal(call.name, 'search_general_memory');
      return executeMemory(call, context);
    },
    message: 'How do I feel about linen lampshades?',
    responses: [
      openAIOutput([toolCall('search_general_memory', 'linen-memory-useful', {
        includeUncertain: false, layer: 'durable', query: 'linen lampshades preference',
      })]),
      (body) => {
        assert.match(body.input.at(-1).output, /"useful":true/);
        return openAIOutput([assistantText('You love linen lampshades.')]);
      },
    ],
    traces,
  });
  assert.equal(result.body.content, 'You love linen lampshades.');
  assert.deepEqual(calls, ['search_general_memory']);
  assert.equal(traces[0].historyFallbackRan, false);
  assert.equal(traces[0].tools[0].useful, true);
});

test('an ordinary non-personal factual answer does not trigger History on a zero-tool route', async () => {
  let executions = 0;
  const traces = [];
  const result = await runRoutingScenario({
    executeServerTool: async () => { executions += 1; throw new Error('unexpected tool'); },
    message: 'How long do lentils take to cook?',
    responses: [openAIOutput([assistantText('Usually 20 to 30 minutes, depending on the lentil.')])],
    traces,
  });
  assert.equal(result.status, 200);
  assert.equal(executions, 0);
  assert.equal(traces[0].historyFallbackRan, false);
  assert.deepEqual(traces[0].tools, []);
});

test('sparkling-water contextual exception does not replace the durable preference', () => {
  const sourceContext = {
    conversationId: 'sparkling-water-source',
    message: {
      content: 'I generally do not like sparkling water.',
      conversationId: 'sparkling-water-source', id: 'sparkling-water-preference',
      occurredAt: TIME, position: 0, role: 'user',
    },
    nearbyMessages: [],
  };
  let memories = reconcileMemoryAnalysis([], { candidates: [{
    action: 'promote', confidence: 0.99,
    content: 'Generally dislikes sparkling water.', layer: 'durable',
    memoryType: 'preference', provenance: 'explicit_statement', scope: 'general',
    subjectKey: 'sparkling-water-preference',
  }], version: 1 }, sourceContext, {
    createId: () => 'sparkling-water-general', now: () => new Date(TIME),
  });
  memories = reconcileMemoryAnalysis(memories, { candidates: [{
    action: 'exception', confidence: 0.99,
    content: 'Wants sparkling water with dinner tonight.', context: 'dinner tonight',
    existingMemoryId: 'sparkling-water-general', layer: 'current_state',
    memoryType: 'state', provenance: 'explicit_statement', scope: 'general',
    staleAfter: '2026-08-26T04:00:00.000Z', subjectKey: 'sparkling-water-preference',
  }], version: 1 }, {
    conversationId: 'sparkling-water-exception',
    message: {
      content: 'Sparkling water sounds good with dinner tonight.',
      conversationId: 'sparkling-water-exception', id: 'sparkling-water-tonight',
      occurredAt: TIME, position: 0, role: 'user',
    },
    nearbyMessages: [],
  }, {
    createId: () => 'sparkling-water-tonight-only', now: () => new Date(TIME),
  });
  assert.equal(memories.find((memory) => memory.id === 'sparkling-water-general').status, 'current');
  const exception = memories.find((memory) => memory.id === 'sparkling-water-tonight-only');
  assert.equal(exception.status, 'current');
  assert.equal(exception.context, 'dinner tonight');
  assert.equal(exception.staleAfter, '2026-08-26T04:00:00.000Z');
});

test('comet recall with no supporting memory or History stays conservative', async () => {
  const calls = [];
  const result = await runRoutingScenario({
    executeServerTool: async (call) => {
      calls.push(call.name);
      if (call.name === 'search_general_memory') {
        return {
          callId: call.callId, execution: 'server', name: call.name,
          result: { memories: [], status: 'success', truncated: false },
        };
      }
      return {
        callId: call.callId, execution: 'server', name: call.name,
        result: { matches: [], status: 'success', truncated: false },
      };
    },
    message: 'Do I like watching comets?',
    responses: [
      openAIOutput([toolCall('search_general_memory', 'comet-memory', {
        includeUncertain: false, layer: 'durable', query: 'comet preference',
      })]),
      openAIOutput([toolCall('search_completed_conversations', 'comet-history', {
        preferredRole: 'user', query: 'comet preference', recencyBias: 'neutral',
      })]),
      openAIOutput([assistantText('I don’t have anything showing how you feel about comets.')]),
    ],
  });
  assert.equal(result.body.content, 'I don’t have anything showing how you feel about comets.');
  assert.deepEqual(calls, ['search_general_memory', 'search_completed_conversations']);
  assert.doesNotMatch(result.body.content, /you (like|love|dislike|hate) comets/i);
});

test('umbrella correction normalizes analyzer identity drift before supersession commit', async () => {
  const sourceContext = {
    conversationId: 'umbrella-source',
    message: {
      content: 'I borrowed a blue umbrella from my cousin, and I still have it with me',
      conversationId: 'umbrella-source', id: 'umbrella-source-message',
      occurredAt: TIME, position: 0, role: 'user',
    },
    nearbyMessages: [],
  };
  let memories = reconcileMemoryAnalysis([], { candidates: [{
    action: 'promote', confidence: 0.99,
    content: 'Currently has a blue umbrella borrowed from a cousin.',
    context: 'temporary possession', layer: 'current_state', memoryType: 'state',
    provenance: 'explicit_statement', scope: 'general',
    staleAfter: '2026-09-08T12:00:00.000Z',
    subjectKey: 'borrowed-blue-umbrella-in-possession',
  }], version: 1 }, sourceContext, {
    createId: () => 'memory-umbrella', now: () => new Date(TIME),
  });
  const correctionContext = {
    conversationId: 'umbrella-correction',
    message: {
      content: 'I returned the umbrella to my cousin already',
      conversationId: 'umbrella-correction', id: 'umbrella-return-message',
      occurredAt: TIME, position: 0, role: 'user',
    },
    nearbyMessages: [],
  };
  let committedAnalysis;
  let complete = false;
  const processor = new MemoryProcessor({ analyze: async () => ({ candidates: [{
    action: 'supersede', confidence: 0.99,
    content: 'Returned the blue umbrella to the cousin and no longer has it.',
    context: 'returned item', existingMemoryId: 'memory-umbrella',
    layer: 'current_state', memoryType: 'state', provenance: 'explicit_statement',
    scope: 'general', subjectKey: 'returned-cousins-blue-umbrella',
  }], version: 1 }) }, {
    claimNextMessage: async () => complete ? { status: 'complete' } : {
      claimToken: 'umbrella-correction-claim', context: correctionContext, status: 'claimed',
    },
    commitAnalysis: async ({ analysis }) => {
      committedAnalysis = analysis;
      memories = reconcileMemoryAnalysis(memories, analysis, correctionContext, {
        createId: () => 'memory-umbrella-returned', now: () => new Date(TIME),
      });
      complete = true;
    },
    failMessage: async () => undefined,
    getAnalysisMemories: async () => memories,
    getProjectIdentities: async () => [],
    search: async () => memories,
  });
  await processor.process('umbrella-correction');
  assert.equal(committedAnalysis.candidates[0].subjectKey,
    'borrowed-blue-umbrella-in-possession');
  assert.equal(committedAnalysis.candidates[0].context, 'temporary possession');
  assert.equal(memories[0].status, 'superseded');
  assert.equal(memories[0].supersededByMemoryId, 'memory-umbrella-returned');
  assert.equal(memories[1].status, 'current');
  assert.equal(memories[1].supersedesMemoryId, 'memory-umbrella');
});

test('post-correction fresh recall uses the returned umbrella state as current truth', async () => {
  const calls = [];
  const returned = memoryItem({
    content: 'Returned the blue umbrella to the cousin and no longer has it.',
    id: 'memory-umbrella-returned', layer: 'current_state', memoryType: 'state',
    subjectKey: 'borrowed-blue-umbrella-in-possession',
  });
  const result = await runRoutingScenario({
    executeServerTool: async (call) => {
      calls.push(call.name);
      return {
        callId: call.callId, execution: 'server', name: call.name,
        result: { memories: [returned], status: 'success', truncated: false },
      };
    },
    message: 'Do I still have my cousins umbrella',
    responses: [
      openAIOutput([toolCall('search_general_memory', 'returned-memory', {
        includeUncertain: false, layer: 'current_state', query: 'cousin umbrella',
      })]),
      openAIOutput([assistantText('No — you returned the blue umbrella to your cousin.')]),
    ],
  });
  assert.equal(result.body.content, 'No — you returned the blue umbrella to your cousin.');
  assert.deepEqual(calls, ['search_general_memory']);
});

test('a deterministic invalid commit is marked terminal and not resubmitted unchanged', async () => {
  const messageContext = {
    conversationId: 'invalid-correction',
    message: {
      content: 'I returned it already', conversationId: 'invalid-correction',
      id: 'invalid-correction-message', occurredAt: TIME, position: 0, role: 'user',
    },
    nearbyMessages: [],
  };
  let analyzerCalls = 0;
  let claimCalls = 0;
  let checkpointError;
  let terminal = false;
  const processor = new MemoryProcessor({ analyze: async () => {
    analyzerCalls += 1;
    return { candidates: [], version: 1 };
  } }, {
    claimNextMessage: async () => {
      claimCalls += 1;
      return terminal ? { status: 'complete' } : {
        claimToken: 'invalid-correction-claim', context: messageContext, status: 'claimed',
      };
    },
    commitAnalysis: async () => {
      throw new Error('The referenced memory has a different logical identity.');
    },
    failMessage: async ({ error }) => {
      checkpointError = error;
      terminal = error.startsWith('[nonretryable] ');
    },
    getAnalysisMemories: async () => [],
    getProjectIdentities: async () => [],
    search: async () => [],
  });
  await assert.rejects(processor.process('invalid-correction'), /different logical identity/);
  assert.equal(isDeterministicMemoryCommitFailure(
    new Error('The referenced memory has a different logical identity.')), true);
  assert.match(checkpointError, /^\[nonretryable\]/);
  assert.deepEqual(await processor.process('invalid-correction'), {
    processedMessageCount: 0, status: 'processed',
  });
  assert.equal(analyzerCalls, 1);
  assert.equal(claimCalls, 2);
});

test('a repeat or supersede reference outside owner-scoped analysis context is rejected', () => {
  assert.throws(() => validateMemoryAnalysis({ candidates: [{
    action: 'supersede', confidence: 0.99, content: 'Returned the umbrella.',
    existingMemoryId: 'foreign-or-invented-memory', layer: 'current_state',
    memoryType: 'state', provenance: 'explicit_statement', scope: 'general',
    subjectKey: 'umbrella-possession',
  }], version: 1 }, []), /referenced memory was not found/);
});

test('acknowledgement policy forbids persistence promises without commit confirmation', async () => {
  let instructions;
  const result = await runRoutingScenario({
    executeServerTool: async () => { throw new Error('no tool expected'); },
    message: 'I returned the umbrella to my cousin already',
    responses: [(body) => {
      instructions = body.instructions;
      return openAIOutput([assistantText('Understood — you returned it.')]);
    }],
  });
  assert.match(instructions, /must not promise or imply durable persistence/);
  assert.match(instructions, /does not receive confirmed memory-commit status/);
  assert.equal(result.body.content, 'Understood — you returned it.');
  assert.doesNotMatch(result.body.content, /remember|keep that in mind|treat that as current/i);
});
