import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ASSISTANT_TOOL_CONTRACTS } from '../src/contracts/assistant/tool-registry.ts';
import {
  createAssistantConversationHistoryToolExecutor,
  expandConversationHistorySearchQuery,
} from '../src/server/assistant/conversation-history-tool-executor.ts';
import { handleAssistantRequest } from '../src/server/assistant/assistant-handler.ts';
import { createAssistantInstructions } from '../src/server/assistant/openai-assistant-provider.ts';
import {
  SupabaseConversationHistorySearchRepository,
} from '../src/server/conversations/conversation-history-search-repository.ts';
import { InvalidAccessTokenError } from '../src/server/auth/supabase-token-verifier.ts';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';
const ACCESS_TOKEN = 'history-search-token';
const CONTEXT = {
  currentLocalDate: 'August 21, 2026',
  currentLocalTime: '11:00:00 AM',
  dayOfWeek: 'Friday',
  timezone: 'America/Toronto',
};
const BASE_REQUEST = {
  context: CONTEXT,
  messages: [{ content: 'What was that workout plan you suggested?', role: 'user' }],
  sessionId: 'history-search-session',
};

function call(query, callId = 'history-call', overrides = {}) {
  return {
    arguments: {
      preferredRole: 'assistant',
      query,
      recencyBias: 'neutral',
      ...overrides,
    },
    callId,
    execution: 'server',
    name: 'search_completed_conversations',
  };
}

function row(overrides = {}) {
  return {
    completedAt: '2026-08-10T12:10:00.000Z',
    content: 'Try three gym days: legs, upper body, then a lighter full-body day.',
    conversationId: 'conversation-workout',
    occurredAt: '2026-08-10T12:05:00.000Z',
    position: 3,
    relevance: 0.8,
    role: 'assistant',
    truncated: false,
    ...overrides,
  };
}

function repositoryFor(rows, queries = [], evidenceRows = rows) {
  return {
    async search(query, maximumConversations) {
      queries.push({ maximumConversations, query, stage: 'conversation' });
      return rows;
    },
    async searchEvidence(
      conversationIds,
      query,
      preferredRole,
      preferRecent,
      maximumMessages,
    ) {
      queries.push({
        conversationIds,
        maximumMessages,
        preferRecent,
        preferredRole,
        query,
        stage: 'evidence',
      });
      return evidenceRows;
    },
  };
}

function openAIResponse(output) {
  return new Response(JSON.stringify({ output }), {
    headers: { 'Content-Type': 'application/json', 'x-request-id': 'history-test' },
  });
}

function toolResponse(
  query,
  callId = 'history-call',
  preferredRole = 'assistant',
  recencyBias = 'neutral',
) {
  return openAIResponse([{
    arguments: JSON.stringify({ preferredRole, query, recencyBias }),
    call_id: callId,
    name: 'search_completed_conversations',
    type: 'function_call',
  }]);
}

function assistantRequest(messages) {
  return new Request('https://assistant.example/api/assistant', {
    body: JSON.stringify({ ...BASE_REQUEST, messages }),
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      Origin: 'https://example.com',
    },
    method: 'POST',
  });
}

async function verifyToken(token) {
  if (token !== ACCESS_TOKEN) throw new InvalidAccessTokenError();
  return { id: USER_ID };
}

const instructions = createAssistantInstructions(BASE_REQUEST);

test('workout-plan recall returns bounded prior-conversation evidence', async () => {
  const queries = [];
  const execute = createAssistantConversationHistoryToolExecutor(
    () => repositoryFor([row()], queries),
  );
  const output = await execute(call('workout plan'), {
    accessToken: ACCESS_TOKEN,
    userId: USER_ID,
  });

  assert.equal(output.result.status, 'success');
  assert.equal(output.result.matches[0].conversationId, 'conversation-workout');
  assert.match(output.result.matches[0].messages[0].content, /three gym days/);
  assert.deepEqual(queries[0].maximumConversations, 4);
  assert.deepEqual(queries[1], {
    conversationIds: ['conversation-workout'],
    maximumMessages: 16,
    preferRecent: false,
    preferredRole: 'assistant',
    query: queries[0].query,
    stage: 'evidence',
  });
});

test('distributed ingredient evidence is gathered from across one selected conversation', async () => {
  const queries = [];
  const initialRows = [row({
    content: 'I am going to tell you what ingredients I have.',
    conversationId: 'conversation-pantry',
    position: 2,
    role: 'user',
  })];
  const ingredients = [
    'basmati rice and sushi rice',
    'eggs, vegetable oil, olive oil, cheese, canned tomatoes, garlic, onions, spices',
    'black beans, chickpeas, lentils',
    'frozen cauliflower, broccoli, spinach',
    'bananas',
    'milk and whipping cream',
    'whole-wheat bread',
    'russet potatoes',
    'canned tuna',
  ];
  const evidenceRows = ingredients.map((content, index) => row({
    completedAt: '2026-08-20T12:30:00.000Z',
    content,
    conversationId: 'conversation-pantry',
    occurredAt: `2026-08-20T12:${String(index + 10).padStart(2, '0')}:00.000Z`,
    position: 5 + index * 4,
    relevance: 0.2,
    role: 'user',
  }));
  const execute = createAssistantConversationHistoryToolExecutor(
    () => repositoryFor(initialRows, queries, evidenceRows),
  );
  const output = await execute(call(
    'What ingredients do I have?',
    'ingredients-call',
    { preferredRole: 'user', recencyBias: 'recent' },
  ), { accessToken: ACCESS_TOKEN, userId: USER_ID });

  assert.equal(output.result.status, 'success');
  assert.deepEqual(
    output.result.matches[0].messages.map(({ content }) => content),
    ingredients,
  );
  assert.ok(output.result.matches[0].messages.some(({ content }) => /canned tuna/.test(content)));
  assert.ok(evidenceRows.at(-1).position - initialRows[0].position > 30);
  assert.equal(queries[1].preferredRole, 'user');
  assert.equal(queries[1].preferRecent, true);
  assert.match(queries[1].query, /rice/);
  assert.match(queries[1].query, /tuna/);
});

test('requested source role and time sensitivity are explicit bounded retrieval signals', () => {
  const contract = ASSISTANT_TOOL_CONTRACTS.find(({ name }) =>
    name === 'search_completed_conversations');
  assert.equal(contract.isArguments({
    preferredRole: 'user',
    query: 'ingredients I have',
    recencyBias: 'recent',
  }), true);
  assert.equal(contract.isArguments({
    preferredRole: 'assistant',
    query: 'workout plan you gave me',
    recencyBias: 'neutral',
  }), true);
  assert.equal(contract.isArguments({
    preferredRole: 'owner',
    query: 'ingredients',
    recencyBias: 'recent',
  }), false);
});

test('assistant-authored workout evidence is requested for what Tina previously gave', async () => {
  const queries = [];
  const execute = createAssistantConversationHistoryToolExecutor(
    () => repositoryFor([row()], queries),
  );
  await execute(call(
    'What workout plan did you give me?',
    'assistant-evidence-call',
    { preferredRole: 'assistant', recencyBias: 'neutral' },
  ), { accessToken: ACCESS_TOKEN, userId: USER_ID });

  assert.equal(queries[1].preferredRole, 'assistant');
  assert.equal(queries[1].preferRecent, false);
});

test('second-stage evidence ranking, not candidate insertion order, orders conversation matches', async () => {
  const newerWeak = row({
    completedAt: '2026-08-20T12:00:00.000Z',
    content: 'We briefly mentioned exercise.',
    conversationId: 'newer-weak',
    relevance: 0.2,
  });
  const olderStrong = row({
    completedAt: '2026-07-20T12:00:00.000Z',
    content: 'The exact plan was three gym days: legs, upper body, and full body.',
    conversationId: 'older-strong',
    relevance: 0.9,
  });
  const execute = createAssistantConversationHistoryToolExecutor(
    () => repositoryFor([newerWeak, olderStrong], [], [olderStrong, newerWeak]),
  );
  const output = await execute(call('workout plan you gave me'), {
    accessToken: ACCESS_TOKEN,
    userId: USER_ID,
  });

  assert.equal(output.result.status, 'success');
  assert.deepEqual(output.result.matches.map(({ conversationId }) => conversationId), [
    'older-strong',
    'newer-weak',
  ]);
});

test('recent inventory evidence can lead when time-sensitive evidence ranking selects it', async () => {
  const oldInventory = row({
    completedAt: '2026-05-01T12:00:00.000Z',
    content: 'I had rice and beans.',
    conversationId: 'old-inventory',
    relevance: 0.8,
    role: 'user',
  });
  const recentInventory = row({
    completedAt: '2026-08-20T12:00:00.000Z',
    content: 'I have potatoes and canned tuna.',
    conversationId: 'recent-inventory',
    relevance: 0.75,
    role: 'user',
  });
  const execute = createAssistantConversationHistoryToolExecutor(
    () => repositoryFor(
      [oldInventory, recentInventory],
      [],
      [recentInventory, oldInventory],
    ),
  );
  const output = await execute(call(
    'What ingredients do I have?',
    'recent-inventory-call',
    { preferredRole: 'user', recencyBias: 'recent' },
  ), { accessToken: ACCESS_TOKEN, userId: USER_ID });

  assert.equal(output.result.status, 'success');
  assert.equal(output.result.matches[0].conversationId, 'recent-inventory');
});

test('gym-routine paraphrase expands to workout and exercise evidence terms', () => {
  const expanded = expandConversationHistorySearchQuery('What was that gym routine you gave me?');
  assert.match(expanded, /gym/);
  assert.match(expanded, /workout/);
  assert.match(expanded, /exercise/);
  assert.match(expanded, /schedule/);
});

test('we-talked-before wording attempts History retrieval before repetition', () => {
  assert.match(instructions, /we talked about this before/);
  assert.match(instructions, /Do not say you cannot browse old chats/);
});

test('current Project-state questions prefer authoritative Project truth', () => {
  assert.match(instructions, /When the user asks for current state or the current decision, prefer current structured Project truth/);
  assert.match(instructions, /Completed conversations are historical evidence/);
});

test('questions about what was discussed prefer completed-conversation evidence', () => {
  assert.match(instructions, /When the user asks what was discussed, suggested, said, named, or considered before, prefer relevant completed-conversation evidence/);
  const contract = ASSISTANT_TOOL_CONTRACTS.find(({ name }) =>
    name === 'search_completed_conversations');
  assert.match(contract.openAI.description, /what they or Tina previously said, suggested, discussed/);
});

test('current interpretations must be framed as inference rather than saved fact', () => {
  assert.match(instructions, /“My read is” or “From that, it reads…” for your current inference/);
  assert.match(instructions, /Use a present inference only when appropriate and label it from the start/);
});

test('one clear historical match is supplied to synthesis naturally', async () => {
  const requests = [];
  const execute = createAssistantConversationHistoryToolExecutor(
    () => repositoryFor([row()]),
  );
  const responses = [
    toolResponse('workout plan gym routine'),
    openAIResponse([{ content: [{
      text: 'It was three gym days: legs, upper body, then a lighter full-body day.',
      type: 'output_text',
    }], type: 'message' }]),
  ];
  const response = await handleAssistantRequest(assistantRequest(BASE_REQUEST.messages), {
    allowedOrigin: 'https://example.com',
    apiKey: 'test-key',
    executeServerTool: execute,
    fetchImplementation: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      return responses.shift();
    },
    verifyAccessToken: verifyToken,
  });

  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).content,
    'It was three gym days: legs, upper body, then a lighter full-body day.',
  );
  assert.match(requests[1].input.at(-1).output, /conversation-workout/);
  assert.doesNotMatch(requests[1].input.at(-1).output, /ownerId|history-search-token/);
});

test('distributed ingredient evidence reaches one grounded synthesized answer', async () => {
  const evidenceRows = [
    row({ content: 'basmati rice and sushi rice', conversationId: 'pantry', position: 4, role: 'user' }),
    row({ content: 'eggs, olive oil, cheese, tomatoes, garlic, and onions', conversationId: 'pantry', position: 11, role: 'user' }),
    row({ content: 'black beans, chickpeas, and lentils', conversationId: 'pantry', position: 19, role: 'user' }),
    row({ content: 'frozen cauliflower, broccoli, and spinach', conversationId: 'pantry', position: 27, role: 'user' }),
    row({ content: 'milk, bread, potatoes, and canned tuna', conversationId: 'pantry', position: 38, role: 'user' }),
  ];
  const execute = createAssistantConversationHistoryToolExecutor(() => repositoryFor([
    row({
      content: 'I will tell you what ingredients I have.',
      conversationId: 'pantry',
      position: 2,
      role: 'user',
    }),
  ], [], evidenceRows));
  const requests = [];
  const responses = [
    toolResponse('ingredients inventory pantry', 'pantry-call', 'user', 'recent'),
    openAIResponse([{ content: [{
      text: 'You told me you have basmati and sushi rice, eggs, olive oil, cheese, tomatoes, garlic, onions, black beans, chickpeas, lentils, frozen cauliflower, broccoli, spinach, milk, bread, potatoes, and canned tuna.',
      type: 'output_text',
    }], type: 'message' }]),
  ];
  const response = await handleAssistantRequest(assistantRequest([
    { content: 'What ingredients do I have?', role: 'user' },
  ]), {
    allowedOrigin: 'https://example.com',
    apiKey: 'test-key',
    executeServerTool: execute,
    fetchImplementation: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      return responses.shift();
    },
    verifyAccessToken: verifyToken,
  });

  assert.equal(response.status, 200);
  const answer = (await response.json()).content;
  assert.match(answer, /basmati and sushi rice/);
  assert.match(answer, /canned tuna/);
  assert.match(requests[1].input.at(-1).output, /basmati rice/);
  assert.doesNotMatch(requests[1].input.at(-1).output, /ownerId/);
});

test('two distinct historical matches support useful clarification instead of guessing', async () => {
  const execute = createAssistantConversationHistoryToolExecutor(() => repositoryFor([
    row(),
    row({
      content: 'For running, alternate an easy run with short intervals.',
      conversationId: 'conversation-running',
      relevance: 0.7,
    }),
  ]));
  const responses = [
    toolResponse('workout exercise plan'),
    openAIResponse([{ content: [{
      text: 'Do you mean the three-day gym plan or the running plan?',
      type: 'output_text',
    }], type: 'message' }]),
  ];
  const response = await handleAssistantRequest(assistantRequest(BASE_REQUEST.messages), {
    allowedOrigin: 'https://example.com',
    apiKey: 'test-key',
    executeServerTool: execute,
    fetchImplementation: async () => responses.shift(),
    verifyAccessToken: verifyToken,
  });

  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).content,
    'Do you mean the three-day gym plan or the running plan?',
  );
});

test('missing exact assistant evidence must not produce a likely workout', () => {
  assert.match(instructions, /If the requested role is not supported by returned messages, do not substitute the other role or supply an unsupported answer/);
  assert.match(instructions, /Never fill a missing workout, recipe, inventory item, decision, or suggestion with details that are not present in the evidence/);
});

test('no History evidence is reported without implying a past fact can be recreated', () => {
  assert.match(instructions, /you could not find prior evidence for the specific thing/);
  assert.match(instructions, /offer to search again when the user provides one additional clue/);
  assert.match(instructions, /Do not imply that a past fact can be recreated from clues/);
  assert.doesNotMatch(instructions, /reconstruct|rebuild/i);
  const contract = ASSISTANT_TOOL_CONTRACTS.find(({ name }) =>
    name === 'search_completed_conversations');
  assert.doesNotMatch(contract.openAI.description, /reconstruct|rebuild/i);
});

test('role fit, relevance, and conditional recency drive second-stage ranking', async () => {
  const migration = await readFile(new URL(
    '../supabase/migrations/20260821170000_add_completed_conversation_evidence_search.sql',
    import.meta.url,
  ), 'utf8');

  assert.match(migration, /weighted_messages\.role_match desc,[\s\S]*weighted_messages\.evidence_score desc/);
  assert.match(migration, /case when p_prefer_recent then[\s\S]*0\.75 \/ \(/);
  assert.match(migration, /scored_messages\.relevance \* 4\.0/);
  assert.match(migration, /case when scored_messages\.direct_match then 2\.0/);
  assert.match(migration, /anchor_distance/);
  assert.match(migration, /case when ranked_per_conversation\.conversation_evidence_rank <= 2 then 0 else 1 end/);
});

test('recency is a bounded weight, so stronger older evidence can beat weak newer evidence', async () => {
  const migration = await readFile(new URL(
    '../supabase/migrations/20260821170000_add_completed_conversation_evidence_search.sql',
    import.meta.url,
  ), 'utf8');

  assert.match(migration, /scored_messages\.relevance \* 4\.0/);
  assert.match(migration, /0\.75 \/ \([\s\S]*30\.0/);
  assert.doesNotMatch(migration, /case when p_prefer_recent then ranked_per_conversation\.completed_at end desc/);
  assert.match(migration, /ranked_per_conversation\.evidence_score desc,[\s\S]*ranked_per_conversation\.completed_at desc/);
});

test('ordinary standalone questions do not require History search', async () => {
  let executions = 0;
  const response = await handleAssistantRequest(assistantRequest([
    { content: 'How long do lentils take to cook?', role: 'user' },
  ]), {
    allowedOrigin: 'https://example.com',
    apiKey: 'test-key',
    executeServerTool: async () => {
      executions += 1;
      throw new Error('unexpected');
    },
    fetchImplementation: async () => openAIResponse([{ content: [{
      text: 'Usually around 20 to 30 minutes, depending on the type.',
      type: 'output_text',
    }], type: 'message' }]),
    verifyAccessToken: verifyToken,
  });

  assert.equal(response.status, 200);
  assert.equal(executions, 0);
});

test('verified-user context scopes History repositories and model arguments contain no owner', async () => {
  const contexts = [];
  const execute = createAssistantConversationHistoryToolExecutor((context) => {
    contexts.push(context);
    return repositoryFor(context.userId === USER_ID ? [row()] : []);
  });
  const ownerOutput = await execute(call('workout'), {
    accessToken: ACCESS_TOKEN,
    userId: USER_ID,
  });
  const otherOutput = await execute(call('workout', 'other-call'), {
    accessToken: 'other-token',
    userId: OTHER_USER_ID,
  });

  assert.equal(ownerOutput.result.matches.length, 1);
  assert.equal(otherOutput.result.matches.length, 0);
  assert.deepEqual(Object.keys(call('workout').arguments), [
    'preferredRole',
    'query',
    'recencyBias',
  ]);
  assert.deepEqual(contexts.map(({ userId }) => userId), [USER_ID, OTHER_USER_ID]);
});

test('History results are bounded by conversations, messages, excerpt, and total contract size', async () => {
  const rows = Array.from({ length: 30 }, (_, index) => row({
    content: 'x'.repeat(2_000),
    conversationId: `conversation-${Math.floor(index / 5)}`,
    occurredAt: `2026-08-10T12:${String(index).padStart(2, '0')}:00.000Z`,
    position: index % 5,
    relevance: 1 - index / 100,
    truncated: index === 0,
  }));
  const execute = createAssistantConversationHistoryToolExecutor(() => repositoryFor(rows));
  const output = await execute(call('workout'), {
    accessToken: ACCESS_TOKEN,
    userId: USER_ID,
  });

  assert.equal(output.result.status, 'success');
  assert.ok(output.result.matches.length <= 4);
  assert.ok(output.result.matches.every((match) => match.messages.length <= 16));
  assert.ok(output.result.matches.reduce(
    (total, match) => total + match.messages.length,
    0,
  ) <= 16);
  assert.ok(output.result.matches.flatMap((match) => match.messages)
    .every((message) => message.content.length <= 600));
  assert.equal(output.result.truncated, true);
  const contract = ASSISTANT_TOOL_CONTRACTS.find(({ name }) =>
    name === 'search_completed_conversations');
  assert.equal(contract.isResult(output.result), true);
});

test('retrieved History is read-only and cannot trigger automatic Project writes', () => {
  assert.match(instructions, /History search is selective and read-only/);
  assert.match(instructions, /Never turn retrieved conversation evidence into a Project write or accepted truth/);
  assert.deepEqual(
    ASSISTANT_TOOL_CONTRACTS.filter(({ name }) => name === 'search_completed_conversations')
      .map(({ execution }) => execution),
    ['server'],
  );
});

test('query expansion supports ordinary paraphrases without embeddings', () => {
  assert.match(expandConversationHistorySearchQuery('funding application'), /grant/);
  assert.match(expandConversationHistorySearchQuery('meal we cooked'), /recipe/);
  assert.match(expandConversationHistorySearchQuery('AQAL brand aesthetic'), /identity/);
  assert.doesNotMatch(expandConversationHistorySearchQuery('photosynthesis'), /workout|grant|recipe/);
});

test('Supabase search RPC derives ownership from JWT and accepts no client owner ID', async () => {
  const calls = [];
  const repository = new SupabaseConversationHistorySearchRepository({
    async rpc(name, argumentsValue) {
      calls.push({ argumentsValue, name });
      return { data: [], error: null };
    },
  });
  await repository.search('workout OR gym', 4);
  await repository.searchEvidence(
    ['conversation-workout'],
    'workout OR gym',
    'assistant',
    false,
    16,
  );

  assert.deepEqual(calls[0], {
    argumentsValue: {
      p_max_conversations: 4,
      p_search_query: 'workout OR gym',
    },
    name: 'search_completed_conversation_messages',
  });
  assert.deepEqual(calls[1], {
    argumentsValue: {
      p_conversation_ids: ['conversation-workout'],
      p_max_messages: 16,
      p_prefer_recent: false,
      p_preferred_role: 'assistant',
      p_search_query: 'workout OR gym',
    },
    name: 'search_completed_conversation_evidence',
  });
  assert.equal('owner_id' in calls[0].argumentsValue, false);
  assert.equal('owner_id' in calls[1].argumentsValue, false);
});

test('within-conversation evidence RPC is owner-scoped, read-only, and bounded', async () => {
  const migration = await readFile(new URL(
    '../supabase/migrations/20260821170000_add_completed_conversation_evidence_search.sql',
    import.meta.url,
  ), 'utf8');

  assert.match(migration, /authenticated_owner uuid := auth\.uid\(\)/);
  assert.match(migration, /security invoker/);
  assert.match(migration, /conversations\.owner_id = authenticated_owner/);
  assert.match(migration, /messages\.owner_id = authenticated_owner/);
  assert.match(migration, /cardinality\(p_conversation_ids\) > 4/);
  assert.match(migration, /p_max_messages > 16/);
  assert.match(migration, /left\(globally_ranked\.content, 600\)/);
  assert.match(migration, /revoke all on function .* from public, anon/s);
  assert.match(migration, /grant execute on function .* to authenticated/s);
  assert.doesNotMatch(migration, /p_owner|service_role|security definer|\binsert\b|\bupdate\b|\bdelete\b/i);
});

test('History-search migration is indexed, bounded, authenticated, read-only, and RLS-compatible', async () => {
  const migration = await readFile(new URL(
    '../supabase/migrations/20260821160000_add_completed_conversation_search.sql',
    import.meta.url,
  ), 'utf8');

  assert.match(migration, /generated always as \(to_tsvector\('english', content\)\) stored/);
  assert.match(migration, /using gin\(search_vector\)/);
  assert.match(migration, /authenticated_owner uuid := auth\.uid\(\)/);
  assert.match(migration, /security invoker/);
  assert.match(migration, /messages\.owner_id = authenticated_owner/);
  assert.match(migration, /p_max_conversations > 4/);
  assert.match(migration, /left\(nearby\.content, 700\)/);
  assert.match(migration, /limit 3/);
  assert.match(migration, /revoke all on function .* from public, anon/s);
  assert.match(migration, /grant execute on function .* to authenticated/s);
  assert.doesNotMatch(migration, /p_owner|service_role|security definer/);
});
