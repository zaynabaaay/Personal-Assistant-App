import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  chatGroupTitle,
  chatMetadata,
  groupChats,
} from '../src/features/chats/chat-presentation.ts';
import {
  generateReadableConversationTitle,
  isPoorConversationTitle,
  normalizeGeneratedConversationTitle,
  selectTitleUserMessages,
} from '../src/services/conversations/conversation-title.ts';

function message(content, role = 'user') {
  return { content, conversationId: 'chat-1', id: 'message-1', occurredAt: '', position: 0, role };
}

function transcript(contents) {
  return { messages: contents.map((content, position) => ({
    ...message(typeof content === 'string' ? content : content.content, content.role ?? 'user'),
    id: `message-${position}`,
    position,
  })) };
}

function conversation(completedAt, overrides = {}) {
  return {
    completedAt,
    createdAt: completedAt,
    id: completedAt,
    messageCount: 11,
    metadataStatus: 'fallback',
    processingAttempts: 0,
    processingStatus: 'processed',
    startedAt: completedAt,
    status: 'completed',
    summary: 'Completed conversation with 11 messages.',
    title: 'Korean Stew Ideas',
    updatedAt: completedAt,
    ...overrides,
  };
}

test('readable title generation is short, content-based, and has a safe fallback', () => {
  assert.equal(generateReadableConversationTitle({ messages: [message('I prefer sparkling water.')] }),
    'Sparkling Water');
  assert.equal(generateReadableConversationTitle({ messages: [message('Can you give me Korean stew ideas?')] }),
    'Korean Stew Ideas');
  assert.equal(generateReadableConversationTitle({ messages: [
    message('Hi Tina'),
    { ...message('I like linen lampshades.'), id: 'message-2', position: 1 },
  ] }), 'Linen Lampshades');
  assert.equal(generateReadableConversationTitle({ messages: [message('', 'assistant')] }), 'Saved Chat');
  assert.equal(normalizeGeneratedConversationTitle('Conversation — 2026-08-25 16:02', {
    messages: [message('I like linen lampshades.')],
  }), 'Linen Lampshades');
});

test('question framing becomes short subject-oriented archive labels', () => {
  assert.equal(generateReadableConversationTitle(transcript([
    'What colour sofa do I want?',
  ])), 'Sofa Colour');
  assert.equal(generateReadableConversationTitle(transcript([
    'Do I keep my phone silent at night?',
  ])), 'Phone Silent at Night');
  assert.equal(generateReadableConversationTitle(transcript([
    'How do I like my lighting?',
  ])), 'Lighting Preferences');
  assert.equal(generateReadableConversationTitle(transcript([
    'What did I decide for the reading corner?',
  ])), 'Reading Corner Decision');
  assert.equal(generateReadableConversationTitle(transcript([
    'What did I decide my future bakery name should be?',
  ])), 'Future Bakery Name');
});

test('later user-authored modifiers outrank literal recall questions', () => {
  assert.equal(generateReadableConversationTitle(transcript([
    'What did I say about shelves?',
    { content: 'Walnut shelves could add warmth.', role: 'assistant' },
    'I think cedar shelves would look nice.',
  ])), 'Cedar Shelves');
  assert.equal(generateReadableConversationTitle(transcript([
    'What kind of planters do I like?',
    'Maybe I need to think about it.',
    'I prefer terracotta planters.',
  ])), 'Terracotta Planters');
});

test('broad multi-topic preferences receive a neutral collective label', () => {
  assert.equal(generateReadableConversationTitle(transcript([
    'I prefer sparkling water.',
    'I like warm lighting.',
    'I love linen lampshades.',
  ])), 'Everyday Preferences');
});

test('assistant suggestions are excluded unless the user states the subject themselves', () => {
  assert.equal(generateReadableConversationTitle(transcript([
    'What did I say about shelves?',
    { content: 'You could use walnut shelves.', role: 'assistant' },
    "No, I don't want that.",
  ])), 'Shelves Chat');
});

test('title context is bounded while retaining early questions and later conclusions', () => {
  const selected = selectTitleUserMessages(transcript(Array.from({ length: 12 }, (_, index) =>
    index === 0 ? 'What did I say about shelves?' :
      index === 11 ? 'I think cedar shelves would look nice.' : `Useful note ${index}`
  )));
  assert.equal(selected.length, 8);
  assert.equal(selected[0], 'What did I say about shelves?');
  assert.equal(selected.at(-1), 'I think cedar shelves would look nice.');
  assert.ok(selected.join('').length <= 2_400);
});

test('poor stored titles are detected and malformed regeneration fails safe', () => {
  for (const title of [
    'What Did I Decide For The',
    'What Did I Decide My Future',
    'Do I Keep My Phone Silent',
    'Conversation — 2026-08-25 16:02',
    'Saved Chat',
  ]) assert.equal(isPoorConversationTitle(title), true, title);
  assert.equal(isPoorConversationTitle('Reading Corner Decision'), false);
  assert.equal(isPoorConversationTitle('Phone Silent at Night'), false);
  assert.equal(normalizeGeneratedConversationTitle('What Did I Decide For The', transcript([
    'What did I decide for the?',
  ])), 'Saved Chat');
  assert.equal(generateReadableConversationTitle(transcript(['Okay', 'Thanks'])), 'Saved Chat');
});

test('chat metadata keeps local date, local time, and secondary message count', () => {
  const rendered = chatMetadata(conversation('2026-08-25T16:03:00.000Z'));
  assert.match(rendered, /Aug 25/);
  assert.match(rendered, /11 messages/);
  assert.match(rendered, / · /);
});

test('Today and Yesterday grouping uses local calendar dates rather than UTC dates', () => {
  const now = new Date(2026, 7, 25, 0, 30);
  const today = new Date(2026, 7, 25, 0, 5).toISOString();
  const yesterday = new Date(2026, 7, 24, 23, 55).toISOString();
  assert.equal(chatGroupTitle(today, now), 'Today');
  assert.equal(chatGroupTitle(yesterday, now), 'Yesterday');
  assert.deepEqual(groupChats([conversation(today), conversation(yesterday)], now)
    .map((group) => group.title), ['Today', 'Yesterday']);
});

test('archive UI is labeled Chats, uses readable detail titles, and confirms deletion', async () => {
  const [home, list, detail] = await Promise.all([
    readFile(new URL('../src/features/home/home-screen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/history/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/history/[id].tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(home, />Chats<|saved to Chats/);
  assert.match(list, />Chats</);
  assert.doesNotMatch(list, /Completed conversation with/);
  assert.match(detail, /record\.conversation\.title/);
  assert.match(detail, /Delete this chat\?/);
  assert.match(detail, /Alert\.alert/);
  assert.match(detail, /style: 'destructive'/);
});

test('deletion RPC is JWT-owned and preserves memory and Project truth while clearing provenance', async () => {
  const migration = await readFile(new URL(
    '../supabase/migrations/20260825180000_add_completed_conversation_deletion.sql',
    import.meta.url,
  ), 'utf8');
  assert.match(migration, /authenticated_owner uuid := auth\.uid\(\)/);
  assert.match(migration, /owner_id = authenticated_owner and id = p_conversation_id/);
  assert.doesNotMatch(migration, /p_owner|p_user/);
  assert.match(migration, /set source_conversation_id = null/);
  assert.match(migration, /source_references = coalesce/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /memory_message_processing[\s\S]*for update/);
  assert.doesNotMatch(migration, /delete from public\.general_memories/);
  assert.doesNotMatch(migration, /delete from public\.project_(?:tasks|decisions|knowledge_items|work_sessions)/);
  assert.match(migration, /delete from public\.memory_message_processing/);
  assert.match(migration, /delete from public\.completed_conversations/);
  assert.match(migration, /grant execute .* to authenticated/);
});

test('legacy title repair RPC is owner-scoped, compare-and-set, and title-only', async () => {
  const migration = await readFile(new URL(
    '../supabase/migrations/20260825200000_refine_completed_conversation_titles.sql',
    import.meta.url,
  ), 'utf8');
  assert.match(migration, /authenticated_owner uuid := auth\.uid\(\)/);
  assert.match(migration, /owner_id = authenticated_owner and id = p_conversation_id/);
  assert.match(migration, /stored_title is distinct from p_expected_title/);
  assert.match(migration, /if not current_is_poor or replacement_is_poor then return false/);
  assert.match(migration, /set title = btrim\(p_title\), metadata_status = 'fallback'/);
  assert.doesNotMatch(migration, /general_memories|project_(?:tasks|decisions|knowledge_items)/);
  assert.doesNotMatch(migration, /p_owner|p_user/);
});
