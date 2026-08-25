import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ConversationService,
  createActiveConversation,
  createConversationMessageId,
  fallbackConversationMetadata,
  finishConversationAndReset,
} from '../src/services/conversations/conversation-service.ts';
import { finishConversationLifecycle } from '../src/services/conversations/conversation-finish-lifecycle.ts';

const STARTED_AT = '2026-08-21T14:30:00.000Z';
const COMPLETED_AT = '2026-08-21T14:35:00.000Z';

function activeConversation(id = 'conversation-1') {
  return {
    createdAt: STARTED_AT,
    id,
    revision: 2,
    startedAt: STARTED_AT,
    updatedAt: '2026-08-21T14:30:04.000Z',
    messages: [
      {
        content: 'Please help me plan the afternoon.',
        conversationId: id,
        id: `${id}:message:0`,
        occurredAt: '2026-08-21T14:30:02.000Z',
        position: 0,
        role: 'user',
      },
      {
        content: 'Let’s start with your highest-priority commitment.',
        conversationId: id,
        id: `${id}:message:1`,
        occurredAt: '2026-08-21T14:30:04.000Z',
        position: 1,
        role: 'assistant',
      },
    ],
  };
}

class DurableConversationStore {
  activeConversations = new Map();
  conversations = new Map();
  messages = new Map();
}

class InMemoryConversationRepository {
  constructor(store, owner = 'owner-1') {
    this.store = store;
    this.owner = owner;
    this.writeCount = 0;
    this.finalizeCount = 0;
    this.titleUpdateCount = 0;
    this.failNextWrite = false;
    this.normalizeTimestampsOnRead = false;
  }

  key(id) {
    return `${this.owner}:${id}`;
  }

  activeKey() {
    return this.owner;
  }

  async deleteCompletedConversation(id) {
    const key = this.key(id);
    const existed = this.store.conversations.delete(key);
    this.store.messages.delete(key);
    return existed;
  }

  async saveActiveConversationAtomically(conversation) {
    this.writeCount += 1;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('simulated persistence failure');
    }

    const existing = this.store.activeConversations.get(this.activeKey());
    if (existing?.id !== undefined && existing.id !== conversation.id) {
      throw new Error('another active conversation exists');
    }
    if (existing) {
      const sharedLength = Math.min(existing.messages.length, conversation.messages.length);
      if (JSON.stringify(existing.messages.slice(0, sharedLength)) !==
        JSON.stringify(conversation.messages.slice(0, sharedLength))) {
        throw new Error('active conversation conflict');
      }
      if (existing.messages.length >= conversation.messages.length) return;
    }
    this.store.activeConversations.set(this.activeKey(), structuredClone({
      ...conversation,
      revision: conversation.messages.length,
    }));
  }

  async getActiveConversation() {
    const value = this.store.activeConversations.get(this.activeKey());
    return value ? structuredClone(value) : null;
  }

  async finalizeActiveConversationAtomically(conversation) {
    this.finalizeCount += 1;
    const key = this.key(conversation.id);
    const active = this.store.activeConversations.get(this.activeKey());
    if (this.store.conversations.has(key)) {
      if (!active) return;
      if (active.id !== conversation.id) throw new Error('another active conversation exists');
      if (JSON.stringify(this.store.messages.get(key)) !== JSON.stringify(active.messages)) {
        throw new Error('active and completed transcript conflict');
      }
      this.store.activeConversations.delete(this.activeKey());
      return;
    }
    if (!active || active.id !== conversation.id) throw new Error('active conversation missing');
    this.store.conversations.set(key, structuredClone(conversation));
    this.store.messages.set(key, structuredClone(active.messages));
    this.store.activeConversations.delete(this.activeKey());
  }

  async getCompletedConversation(id) {
    const key = this.key(id);
    const conversation = this.store.conversations.get(key);
    const messages = this.store.messages.get(key);
    if (!conversation || !messages) return null;
    const result = { conversation: structuredClone(conversation), messages: structuredClone(messages) };
    if (this.normalizeTimestampsOnRead) {
      result.messages = result.messages.map((message) => ({
        ...message,
        occurredAt: message.occurredAt.replace('Z', '+00:00'),
      }));
    }
    return result;
  }

  async listCompletedConversations() {
    return [...this.store.conversations.entries()]
      .filter(([key]) => key.startsWith(`${this.owner}:`))
      .map(([, value]) => structuredClone(value))
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  }

  async updateCompletedConversationTitle(id, expectedTitle, title) {
    const key = this.key(id);
    const conversation = this.store.conversations.get(key);
    if (!conversation || conversation.title !== expectedTitle) return false;
    this.titleUpdateCount += 1;
    this.store.conversations.set(key, { ...conversation, metadataStatus: 'fallback', title });
    return true;
  }
}

function service(repository, options = {}) {
  return new ConversationService(repository, {
    now: () => new Date(COMPLETED_AT),
    ...options,
  });
}

function firstMessageDraft(id = 'conversation-1') {
  const active = activeConversation(id);
  active.messages = [active.messages[0]];
  active.revision = 1;
  active.updatedAt = active.messages[0].occurredAt;
  return active;
}

test('the first sent message lazily creates one durable active draft', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  const saved = await service(repository).saveActiveConversation(firstMessageDraft());

  assert.equal(store.activeConversations.size, 1);
  assert.equal(saved.id, 'conversation-1');
  assert.equal(saved.messages.length, 1);
  assert.deepEqual(await service(repository).listCompletedConversations(), []);
});

test('additional sent messages append durably in stable order and survive a new app session', async () => {
  const store = new DurableConversationStore();
  const firstSession = service(new InMemoryConversationRepository(store));
  const first = firstMessageDraft();
  await firstSession.saveActiveConversation(first);
  await firstSession.saveActiveConversation(activeConversation());

  const restored = await service(new InMemoryConversationRepository(store)).getActiveConversation();
  assert.deepEqual(restored?.messages.map((message) => message.position), [0, 1]);
  assert.deepEqual(restored?.messages.map((message) => message.occurredAt), [
    '2026-08-21T14:30:02.000Z',
    '2026-08-21T14:30:04.000Z',
  ]);
  assert.deepEqual(restored?.messages.map((message) => message.role), ['user', 'assistant']);
});

test('repeated active persistence is idempotent and does not duplicate messages', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  const conversationService = service(repository);
  const active = activeConversation();

  await conversationService.saveActiveConversation(active);
  await conversationService.saveActiveConversation(active);

  assert.equal((await conversationService.getActiveConversation())?.messages.length, 2);
  assert.equal(store.activeConversations.size, 1);
});

test('a second client cannot create a different active draft for the same owner', async () => {
  const store = new DurableConversationStore();
  const firstClient = service(new InMemoryConversationRepository(store));
  const secondClient = service(new InMemoryConversationRepository(store));

  await firstClient.saveActiveConversation(firstMessageDraft('conversation-1'));
  await assert.rejects(
    secondClient.saveActiveConversation(firstMessageDraft('conversation-2')),
    /another active conversation exists/,
  );

  assert.equal(store.activeConversations.size, 1);
  assert.equal((await firstClient.getActiveConversation())?.id, 'conversation-1');
});

test('a competing message at an occupied position is rejected without replacing the durable message', async () => {
  const store = new DurableConversationStore();
  const firstClient = service(new InMemoryConversationRepository(store));
  const secondClient = service(new InMemoryConversationRepository(store));
  const original = firstMessageDraft();
  const conflict = structuredClone(original);
  conflict.messages[0] = {
    ...conflict.messages[0],
    content: 'A different message from another client.',
    id: createConversationMessageId(conflict.id),
  };

  await firstClient.saveActiveConversation(original);
  await assert.rejects(secondClient.saveActiveConversation(conflict), /conflict/);

  assert.deepEqual((await firstClient.getActiveConversation())?.messages, original.messages);
});

test('new message IDs remain stable semantic identities rather than transcript positions', () => {
  const first = createConversationMessageId('conversation-1');
  const second = createConversationMessageId('conversation-1');

  assert.notEqual(first, second);
  assert.match(first, /^conversation-1:message:/);
  assert.match(second, /^conversation-1:message:/);
});

test('a failed sent-message save retries without duplication or message loss', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  const conversationService = service(repository);
  const pending = firstMessageDraft();
  repository.failNextWrite = true;

  await assert.rejects(conversationService.saveActiveConversation(pending), /simulated/);
  assert.equal(pending.messages[0].content, 'Please help me plan the afternoon.');
  assert.equal(await conversationService.getActiveConversation(), null);

  const saved = await conversationService.saveActiveConversation(pending);
  await conversationService.saveActiveConversation(pending);
  assert.equal(saved.messages.length, 1);
  assert.equal((await conversationService.getActiveConversation())?.messages.length, 1);
});

test('owner isolation applies to active drafts and signing out does not delete the stored draft', async () => {
  const store = new DurableConversationStore();
  const ownerRepository = new InMemoryConversationRepository(store, 'owner-1');
  await service(ownerRepository).saveActiveConversation(firstMessageDraft());

  assert.equal(await service(new InMemoryConversationRepository(store, 'owner-2'))
    .getActiveConversation(), null);
  assert.equal((await service(new InMemoryConversationRepository(store, 'owner-1'))
    .getActiveConversation())?.messages.length, 1);
});

test('Finish Conversation persists the complete ordered transcript and Chats survives a new service session', async () => {
  const store = new DurableConversationStore();
  const firstRepository = new InMemoryConversationRepository(store);
  const active = activeConversation();

  await service(firstRepository).finishConversation(active);

  const reopenedService = service(new InMemoryConversationRepository(store));
  const reopened = await reopenedService.getCompletedConversation(active.id);
  assert.deepEqual(reopened?.messages, active.messages);
  assert.equal(reopened?.conversation.status, 'completed');
  assert.equal(reopened?.conversation.messageCount, 2);
  assert.equal(reopened?.conversation.processingStatus, 'pending');
  assert.deepEqual(await reopenedService.listCompletedConversations(), [reopened?.conversation]);
  assert.equal(await reopenedService.getActiveConversation(), null);
});

test('an exact Finish Conversation retry is idempotent and does not duplicate messages', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  const conversationService = service(repository);
  const active = activeConversation();

  const first = await conversationService.finishConversation(active);
  const second = await conversationService.finishConversation(active);

  assert.deepEqual(second, first);
  assert.equal(repository.writeCount, 1);
  assert.equal(repository.finalizeCount, 1);
  assert.equal(store.conversations.size, 1);
  assert.equal(store.messages.get(repository.key(active.id)).length, 2);
});

test('an exact Finish retry clears a matching active row left after interrupted legacy finalization', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  const conversationService = service(repository);
  const active = activeConversation();
  const completed = await conversationService.finishConversation(active);
  store.activeConversations.set(repository.activeKey(), structuredClone(active));

  const recovered = await conversationService.finishConversation(active);

  assert.deepEqual(recovered, completed);
  assert.equal(await conversationService.getActiveConversation(), null);
  assert.equal(store.conversations.size, 1);
  assert.equal(store.messages.get(repository.key(active.id)).length, 2);
});

test('rapid repeated Finish finalizes one active draft exactly once', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  const conversationService = service(repository);
  const active = activeConversation();

  const [first, second] = await Promise.all([
    conversationService.finishConversation(active),
    conversationService.finishConversation(active),
  ]);

  assert.deepEqual(second, first);
  assert.equal(store.conversations.size, 1);
  assert.equal(store.messages.get(repository.key(active.id)).length, 2);
  assert.equal(await conversationService.getActiveConversation(), null);
});

test('the fresh conversation after Finish remains lazy until its first sent message', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  const conversationService = service(repository);
  await conversationService.finishConversation(activeConversation());

  const fresh = createActiveConversation(new Date('2026-08-21T15:00:00.000Z'));
  assert.equal(fresh.messages.length, 0);
  assert.equal(await conversationService.getActiveConversation(), null);

  const first = {
    content: 'This starts the next conversation.',
    conversationId: fresh.id,
    id: `${fresh.id}:message:0`,
    occurredAt: '2026-08-21T15:00:01.000Z',
    position: 0,
    role: 'user',
  };
  const saved = await conversationService.saveActiveConversation({
    ...fresh,
    messages: [first],
    revision: 1,
    updatedAt: first.occurredAt,
  });
  assert.equal(saved.id, fresh.id);
  assert.equal(saved.messages.length, 1);
  assert.equal(store.conversations.size, 1);
});

test('a persistence failure leaves the active conversation intact and does not reset Home', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  repository.failNextWrite = true;
  const active = activeConversation();
  let resets = 0;

  await assert.rejects(
    finishConversationAndReset(service(repository), active, () => { resets += 1; }),
    /simulated persistence failure/,
  );

  assert.equal(resets, 0);
  assert.equal(active.messages.length, 2);
  assert.equal(store.conversations.size, 0);
});

test('Home resets only after a completed transcript is stored and verified', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  let resets = 0;

  await finishConversationAndReset(
    service(repository),
    activeConversation(),
    () => { resets += 1; },
  );

  assert.equal(resets, 1);
  assert.equal(store.conversations.size, 1);
});

test('persistence verification accepts PostgreSQL timestamp normalization', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  repository.normalizeTimestampsOnRead = true;
  let resets = 0;

  const completed = await finishConversationAndReset(
    service(repository),
    activeConversation(),
    () => { resets += 1; },
  );

  assert.equal(resets, 1);
  assert.equal(completed.messages[0].occurredAt, '2026-08-21T14:30:02.000+00:00');
  assert.equal((await service(repository).listCompletedConversations()).length, 1);
});

test('a post-save Project processing failure remains saved and is not a save failure', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  repository.normalizeTimestampsOnRead = true;
  const active = activeConversation();
  const conversationService = service(repository);
  let persistedNotice = 0;
  let resets = 0;

  const result = await finishConversationLifecycle({
    active,
    onPersisted: () => { persistedNotice += 1; },
    process: async () => { throw new Error('processing unavailable'); },
    reset: () => { resets += 1; },
    service: conversationService,
  });

  assert.equal(result.processingStatus, 'failed');
  assert.equal(persistedNotice, 1);
  assert.equal(resets, 1);
  assert.deepEqual((await service(repository).getCompletedConversation(active.id))?.messages,
    result.completed.messages);
  assert.equal(await conversationService.getActiveConversation(), null);

  const next = firstMessageDraft('conversation-2');
  assert.equal((await conversationService.saveActiveConversation(next)).id, 'conversation-2');
});

test('a 202 Project processing result remains saved and is represented as processing', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);

  const result = await finishConversationLifecycle({
    active: activeConversation(),
    process: async () => ({ status: 'processing' }),
    reset: () => undefined,
    service: service(repository),
  });

  assert.equal(result.processingStatus, 'processing');
  assert.equal((await service(repository).listCompletedConversations()).length, 1);
});

test('metadata generation failure uses a deterministic safe fallback without blocking completion', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  const active = activeConversation();
  const expected = fallbackConversationMetadata(active);

  const completed = await service(repository, {
    generateMetadata: async () => { throw new Error('model unavailable'); },
  }).finishConversation(active);

  assert.equal(completed.conversation.metadataStatus, 'fallback');
  assert.equal(completed.conversation.title, expected.title);
  assert.equal(completed.conversation.summary, expected.summary);
  assert.equal(completed.conversation.title, 'Afternoon Plan');
});

test('generated chat metadata is persisted and reused without regenerating on retry', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  let generationCount = 0;
  const conversationService = service(repository, {
    generateMetadata: async () => {
      generationCount += 1;
      return { summary: 'Discussed a drink preference.', title: 'Sparkling Water Preference' };
    },
  });

  const first = await conversationService.finishConversation(activeConversation());
  const second = await conversationService.finishConversation(activeConversation());

  assert.equal(first.conversation.title, 'Sparkling Water Preference');
  assert.equal(second.conversation.title, 'Sparkling Water Preference');
  assert.equal(generationCount, 1);
});

test('poor legacy titles regenerate once from bounded transcript content and good titles remain unchanged', async () => {
  const store = new DurableConversationStore();
  const repository = new InMemoryConversationRepository(store);
  const conversationService = service(repository);
  const active = activeConversation();
  active.messages[0].content = 'What did I say about shelves?';
  active.messages.push({
    content: 'I think cedar shelves would look nice.',
    conversationId: active.id,
    id: `${active.id}:message:2`,
    occurredAt: '2026-08-21T14:30:06.000Z',
    position: 2,
    role: 'user',
  });
  active.revision = 3;
  active.updatedAt = active.messages[2].occurredAt;
  await conversationService.finishConversation(active);
  const key = repository.key(active.id);
  store.conversations.get(key).title = 'What Did I Say About Shelves';

  const firstList = await conversationService.listCompletedConversations();
  const secondList = await conversationService.listCompletedConversations();

  assert.equal(firstList[0].title, 'Cedar Shelves');
  assert.equal(secondList[0].title, 'Cedar Shelves');
  assert.equal(store.conversations.get(key).title, 'Cedar Shelves');
  assert.equal(repository.titleUpdateCount, 1);
});

test('owner can delete an own completed chat idempotently while another owner cannot', async () => {
  const store = new DurableConversationStore();
  const ownerService = service(new InMemoryConversationRepository(store, 'owner-1'));
  const otherService = service(new InMemoryConversationRepository(store, 'owner-2'));
  await ownerService.finishConversation(activeConversation());

  assert.equal(await otherService.deleteCompletedConversation('conversation-1'), false);
  assert.ok(await ownerService.getCompletedConversation('conversation-1'));
  assert.equal(await ownerService.deleteCompletedConversation('conversation-1'), true);
  assert.equal(await ownerService.deleteCompletedConversation('conversation-1'), false);
  assert.equal(await ownerService.getCompletedConversation('conversation-1'), null);
});

test('completed Chats is scoped to the repository owner', async () => {
  const store = new DurableConversationStore();
  const ownerService = service(new InMemoryConversationRepository(store, 'owner-1'));
  const otherService = service(new InMemoryConversationRepository(store, 'owner-2'));

  await ownerService.finishConversation(activeConversation());

  assert.equal(await otherService.getCompletedConversation('conversation-1'), null);
  assert.deepEqual(await otherService.listCompletedConversations(), []);
});

test('the Supabase migration enforces JWT ownership, RLS, authenticated access, and atomic retry safety', async () => {
  const migration = await readFile(new URL(
    '../supabase/migrations/20260821090000_create_completed_conversations.sql',
    import.meta.url,
  ), 'utf8');

  assert.match(migration, /create table public\.completed_conversations/);
  assert.match(migration, /create table public\.conversation_messages/);
  assert.match(migration, /enable row level security/g);
  assert.match(migration, /owner_id = \(select auth\.uid\(\)\)/g);
  assert.match(migration, /authenticated_owner uuid := auth\.uid\(\)/);
  assert.match(migration, /if authenticated_owner is null/);
  assert.match(migration, /security definer/);
  assert.match(migration, /A different transcript already uses this conversation ID/);
  assert.match(migration, /revoke all on function public\.complete_conversation\(jsonb, jsonb\) from public, anon/);
  assert.doesNotMatch(migration, /p_owner|p_user/);
});

test('the Supabase repository never sends a client owner ID to the finalization RPC', async () => {
  const source = await readFile(new URL(
    '../src/services/conversations/supabase-conversation-repository.ts',
    import.meta.url,
  ), 'utf8');

  assert.match(source, /rpc\('finalize_active_conversation'/);
  assert.doesNotMatch(source, /owner_id:/);
  assert.doesNotMatch(source, /ownerId/);
});

test('the active-conversation migration enforces one owner draft, RLS, and atomic finalization', async () => {
  const migration = await readFile(new URL(
    '../supabase/migrations/20260821150000_create_active_conversations.sql',
    import.meta.url,
  ), 'utf8');

  assert.match(migration, /create table public\.active_conversations/);
  assert.match(migration, /owner_id uuid primary key default auth\.uid\(\)/);
  assert.match(migration, /create table public\.active_conversation_messages/);
  assert.match(migration, /create function public\.save_active_conversation/);
  assert.match(migration, /create function public\.finalize_active_conversation/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /The active conversation changed in another session/);
  assert.match(migration, /The active conversation identity conflicts with the stored draft/);
  assert.match(migration, /unique \(owner_id, conversation_id, position\)/);
  assert.match(migration, /supplied_message_count > 50/);
  assert.match(migration, /> 30000/);
  assert.match(migration, /delete from public\.active_conversations/);
  assert.match(migration, /insert into public\.completed_conversations/);
  assert.match(migration, /insert into public\.conversation_messages/);
  assert.match(migration, /enable row level security/g);
  assert.match(migration, /owner_id = \(select auth\.uid\(\)\)/g);
  assert.match(migration, /grant select on table public\.active_conversations to authenticated/);
  assert.match(migration, /revoke all on table public\.active_conversations from public, anon, authenticated/);
  assert.match(migration, /security definer\s+set search_path = ''/g);
  assert.doesNotMatch(migration, /p_owner|p_user|service_role/);
});

test('the Supabase active repository uses authenticated RPCs without a client owner ID', async () => {
  const source = await readFile(new URL(
    '../src/services/conversations/supabase-conversation-repository.ts',
    import.meta.url,
  ), 'utf8');

  assert.match(source, /rpc\('save_active_conversation'/);
  assert.match(source, /rpc\('finalize_active_conversation'/);
  assert.doesNotMatch(source, /owner_id:/);
  assert.doesNotMatch(source, /ownerId/);
});

test('Home removes the visible Clear action and preserves a local retry outbox', async () => {
  const home = await readFile(new URL(
    '../src/features/home/home-screen.tsx',
    import.meta.url,
  ), 'utf8');
  const nativeOutbox = await readFile(new URL(
    '../src/services/conversations/active-conversation-outbox.native.ts',
    import.meta.url,
  ), 'utf8');

  assert.doesNotMatch(home, /Clear active conversation|>Clear</);
  assert.match(home, /activeConversationOutbox\.save/);
  assert.match(home, /Message was not saved\. It is preserved; tap Send to retry\./);
  assert.match(nativeOutbox, /AsyncStorage/);
  assert.match(nativeOutbox, /activeConversationOutboxKey\(userId\)/);
});
