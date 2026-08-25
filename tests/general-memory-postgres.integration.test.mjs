import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import EmbeddedPostgres from 'embedded-postgres';
import pgPackage from 'pg';

const { Client } = pgPackage;
const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-08-21T18:00:00.000Z';
const ROOT = path.resolve(import.meta.dirname, '..');

let databaseDir;
let databasePort;
let embedded;
let admin;

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function authenticatedClient(ownerId) {
  const client = new Client({
    database: 'postgres', host: '127.0.0.1', password: 'memory-test',
    port: databasePort, user: 'postgres',
  });
  await client.connect();
  await client.query('set role authenticated');
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  return client;
}

async function insertConversation(ownerId, conversationId, count = 1, allowOversized = false) {
  if (allowOversized) {
    await admin.query('alter table public.conversation_messages disable trigger conversation_messages_processing_bounds');
  }
  await admin.query(`
    insert into public.completed_conversations (
      owner_id, id, started_at, completed_at, title, summary, status,
      metadata_status, processing_status, processing_attempts, message_count,
      created_at, updated_at
    ) values ($1, $2, $3, $3, 'Memory test', 'Memory test', 'completed',
      'fallback', 'pending', 0, $4, $3, $3)
  `, [ownerId, conversationId, NOW, Math.min(count, 50)]);
  const values = [];
  const placeholders = [];
  for (let index = 0; index < count; index += 1) {
    const offset = values.length;
    values.push(ownerId, `${conversationId}-message-${index}`, conversationId, index,
      `Memory evidence ${index}`, new Date(Date.parse(NOW) + index * 1_000).toISOString());
    placeholders.push(`($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},'user',$${offset + 5},$${offset + 6})`);
  }
  await admin.query(`
    insert into public.conversation_messages (
      owner_id, id, conversation_id, position, role, content, occurred_at
    ) values ${placeholders.join(',')}
  `, values);
  if (allowOversized) {
    await admin.query('alter table public.conversation_messages enable trigger conversation_messages_processing_bounds');
  }
}

async function claim(client, preferredConversationId) {
  const result = await client.query(
    'select public.claim_next_memory_message($1) as claim',
    [preferredConversationId ?? null],
  );
  return result.rows[0].claim;
}

function candidate(overrides = {}) {
  return {
    action: 'promote', confidence: 0.9, content: 'The user prefers bright rooms.',
    layer: 'durable', memoryType: 'preference', provenance: 'explicit_statement',
    scope: 'general', subjectKey: 'lighting:brightness', ...overrides,
  };
}

async function expectedState(client) {
  const result = await client.query(`
    select id, content, context, provenance, status, subject_key, updated_at::text updated_at
    from public.general_memories
    where status in ('current', 'ambiguous', 'stale')
    order by updated_at desc, id
    limit 12
  `);
  return result.rows.map((row) => ({
    content: row.content, ...(row.context ? { context: row.context } : {}), id: row.id,
    provenance: row.provenance, status: row.status, subjectKey: row.subject_key,
    updatedAt: row.updated_at,
  }));
}

async function commit(client, claimValue, analysis, expected = []) {
  return client.query(
    'select public.commit_memory_analysis($1,$2,$3,$4::jsonb,$5::jsonb)',
    [claimValue.context.conversationId, claimValue.context.message.id,
      claimValue.claimToken, JSON.stringify(expected), JSON.stringify(analysis)],
  );
}

async function commitOne(client, conversationId, candidateValue, expected) {
  const claimValue = await claim(client, conversationId);
  assert.equal(claimValue.status, 'claimed');
  await commit(client, claimValue, { candidates: [candidateValue], version: 1 }, expected);
  return claimValue;
}

async function drainMessages(client, maximum) {
  let processed = 0;
  for (; processed < maximum; processed += 1) {
    const claimValue = await claim(client);
    if (claimValue.status === 'complete') return { complete: true, processed };
    assert.equal(claimValue.status, 'claimed');
    await commit(client, claimValue, {
      candidates: [{ action: 'history_only', confidence: 0 }], version: 1,
    });
  }
  return { complete: false, processed };
}

before(async () => {
  databaseDir = await mkdtemp(path.join(os.tmpdir(), 'tina-memory-postgres-'));
  databasePort = await availablePort();
  embedded = new EmbeddedPostgres({
    databaseDir, password: 'memory-test', persistent: false, port: databasePort,
    user: 'postgres', onError: () => undefined, onLog: () => undefined,
  });
  await embedded.initialise();
  await embedded.start();
  admin = embedded.getPgClient();
  await admin.connect();
  await admin.query(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable set search_path = ''
    return nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    insert into auth.users(id) values ('${OWNER_A}'), ('${OWNER_B}');
  `);
  const migrationDir = path.join(ROOT, 'supabase', 'migrations');
  const migrations = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql')).sort();
  for (const migration of migrations) {
    await admin.query(await readFile(path.join(migrationDir, migration), 'utf8'));
  }
});

beforeEach(async () => {
  await admin.query(`
    truncate table public.memory_message_processing, public.general_memories,
      public.active_conversation_messages, public.active_conversations,
      public.conversation_messages, public.completed_conversations,
      public.project_change_events, public.project_work_session_entries,
      public.project_resources, public.project_decisions, public.project_knowledge_items,
      public.project_tasks, public.project_deliverables, public.project_milestones,
      public.project_work_sessions, public.projects cascade
  `);
});

after(async () => {
  await admin?.end();
  await embedded?.stop();
  if (databaseDir) await rm(databaseDir, { force: true, recursive: true });
});

test('migration canonical identity normalizes structural variants without fuzzy matching', async () => {
  const result = await admin.query(`
    select
      public.canonical_general_memory_identity(' Lighting :  Brightness ', 'subject') a,
      public.canonical_general_memory_identity('lighting/brightness', 'subject') b,
      public.canonical_general_memory_identity('LIGHTING___BRIGHTNESS', 'subject') c,
      public.canonical_general_memory_identity('deep   work / invoices', 'context') context_value,
      public.canonical_general_memory_identity('lighting brightness', 'subject') distinct_value
  `);
  assert.equal(result.rows[0].a, 'lighting:brightness');
  assert.equal(result.rows[0].a, result.rows[0].b);
  assert.equal(result.rows[0].a, result.rows[0].c);
  assert.equal(result.rows[0].context_value, 'deep work/invoices');
  assert.notEqual(result.rows[0].a, result.rows[0].distinct_value);
});

test('chat deletion is owner-scoped and preserves memory and Project truth while detaching provenance', async () => {
  await insertConversation(OWNER_A, 'delete-chat');
  await admin.query(`
    insert into public.projects (
      owner_id,id,created_at,name,priority,status,timezone,type,updated_at
    ) values ($1,'delete-project',$2,'Delete test','normal','active','America/Toronto','general',$2)
  `, [OWNER_A, NOW]);
  await admin.query(`
    insert into public.project_work_sessions (
      owner_id,id,created_at,project_id,started_at,title,updated_at,source_conversation_id
    ) values ($1,'delete-session',$2,'delete-project',$2,'Saved work',$2,'delete-chat')
  `, [OWNER_A, NOW]);
  await admin.query(`
    insert into public.general_memories (
      owner_id,id,layer,memory_type,subject_key,content,status,confidence,provenance,
      source_references,evidence_count,last_confirmed_at,created_at,updated_at
    ) values ($1,'delete-memory','durable','preference','drink:water',
      'The user prefers sparkling water.','current',.95,'explicit_statement',
      $3::jsonb,2,$2,$2,$2)
  `, [OWNER_A, NOW, JSON.stringify([
    { conversation_id: 'delete-chat', message_id: 'delete-chat-message-0' },
    { conversation_id: 'kept-chat', message_id: 'kept-message' },
  ])]);
  await admin.query(`
    insert into public.memory_message_processing (
      owner_id,message_id,conversation_id,status,processing_attempts,processed_at,
      claim_token,created_at,updated_at
    ) values ($1,'delete-chat-message-0','delete-chat','processed',1,$2,'delete-token-123456',$2,$2)
  `, [OWNER_A, NOW]);

  const other = await authenticatedClient(OWNER_B);
  const owner = await authenticatedClient(OWNER_A);
  try {
    assert.equal((await other.query(
      "select public.delete_completed_conversation('delete-chat') deleted",
    )).rows[0].deleted, false);
    assert.equal((await admin.query(`select count(*)::integer count
      from public.completed_conversations where owner_id = $1 and id = 'delete-chat'`,
    [OWNER_A])).rows[0].count, 1);

    assert.equal((await owner.query(
      "select public.delete_completed_conversation('delete-chat') deleted",
    )).rows[0].deleted, true);
    assert.equal((await owner.query(
      "select public.delete_completed_conversation('delete-chat') deleted",
    )).rows[0].deleted, false);

    const memory = (await admin.query(`select content,status,confidence,provenance,
      evidence_count,source_references from public.general_memories
      where owner_id = $1 and id = 'delete-memory'`, [OWNER_A])).rows[0];
    assert.equal(memory.content, 'The user prefers sparkling water.');
    assert.equal(memory.status, 'current');
    assert.equal(memory.confidence, 0.95);
    assert.equal(memory.provenance, 'explicit_statement');
    assert.equal(memory.evidence_count, 2);
    assert.deepEqual(memory.source_references,
      [{ conversation_id: 'kept-chat', message_id: 'kept-message' }]);

    const session = (await admin.query(`select source_conversation_id
      from public.project_work_sessions where owner_id = $1 and id = 'delete-session'`,
    [OWNER_A])).rows[0];
    assert.equal(session.source_conversation_id, null);
    assert.equal((await admin.query(`select count(*)::integer count
      from public.memory_message_processing where owner_id = $1 and conversation_id = 'delete-chat'`,
    [OWNER_A])).rows[0].count, 0);
    assert.equal((await admin.query(`select count(*)::integer count
      from public.completed_conversations where owner_id = $1 and id = 'delete-chat'`,
    [OWNER_A])).rows[0].count, 0);
  } finally {
    await owner.end();
    await other.end();
  }
});

test('real claim takeover fences stale commit and failure and processed state cannot regress', async () => {
  await insertConversation(OWNER_A, 'lease-conversation');
  const workerA = await authenticatedClient(OWNER_A);
  const workerB = await authenticatedClient(OWNER_A);
  try {
    const first = await claim(workerA, 'lease-conversation');
    await admin.query(`update public.memory_message_processing
      set updated_at = now() - interval '3 minutes' where owner_id = $1`, [OWNER_A]);
    const second = await claim(workerB, 'lease-conversation');
    assert.notEqual(first.claimToken, second.claimToken);
    await assert.rejects(commit(workerA, first, { candidates: [], version: 1 }), /claim is stale/);
    await assert.rejects(workerA.query(
      'select public.fail_memory_message($1,$2,$3,$4)',
      [first.context.conversationId, first.context.message.id, first.claimToken, 'stale'],
    ), /claim is stale/);
    await commit(workerB, second, { candidates: [], version: 1 });
    await assert.rejects(workerA.query(
      'select public.fail_memory_message($1,$2,$3,$4)',
      [second.context.conversationId, second.context.message.id, second.claimToken, 'late'],
    ), /claim is stale/);
    const checkpoint = await admin.query(
      'select status from public.memory_message_processing where owner_id = $1', [OWNER_A],
    );
    assert.equal(checkpoint.rows[0].status, 'processed');
  } finally {
    await workerA.end();
    await workerB.end();
  }
});

test('concurrent canonical subject variants serialize and reject a stale conflicting commit', async () => {
  await insertConversation(OWNER_A, 'canonical-a');
  await insertConversation(OWNER_A, 'canonical-b');
  const workerA = await authenticatedClient(OWNER_A);
  const workerB = await authenticatedClient(OWNER_A);
  try {
    const claimA = await claim(workerA, 'canonical-a');
    const claimB = await claim(workerB, 'canonical-b');
    const outcomes = await Promise.allSettled([
      commit(workerA, claimA, { candidates: [candidate({ context: 'deep work/invoices' })], version: 1 }),
      commit(workerB, claimB, { candidates: [candidate({
        content: 'The user prefers dim rooms.', context: ' Deep  Work / Invoices ',
        subjectKey: ' LIGHTING / BRIGHTNESS ',
      })], version: 1 }),
    ]);
    assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((value) => value.status === 'rejected').length, 1);
    assert.match(outcomes.find((value) => value.status === 'rejected').reason.message,
      /stale|fresh reconciliation/);
    const active = await admin.query(`select count(*)::integer count
      from public.general_memories where owner_id = $1 and status = 'current'`, [OWNER_A]);
    assert.equal(active.rows[0].count, 1);
  } finally {
    await workerA.end();
    await workerB.end();
  }
});

test('real commit rejects a stale subject snapshot', async () => {
  await insertConversation(OWNER_A, 'stale-base');
  await insertConversation(OWNER_A, 'stale-attempt');
  const client = await authenticatedClient(OWNER_A);
  try {
    await commitOne(client, 'stale-base', candidate(), []);
    const expected = await expectedState(client);
    const staleClaim = await claim(client, 'stale-attempt');
    await admin.query(`update public.general_memories set content = 'Concurrent correction',
      updated_at = now() + interval '1 second' where owner_id = $1`, [OWNER_A]);
    await assert.rejects(commit(client, staleClaim, {
      candidates: [candidate({ action: 'repeat', existingMemoryId: expected[0].id })], version: 1,
    }, expected), /stale and must be retried/);
  } finally {
    await client.end();
  }
});

test('actual commit RPC enforces all provenance ranks', async () => {
  const scenarios = [
    ['inferred', 'explicit_statement', false],
    ['inferred', 'explicit_decision', false],
    ['explicit_statement', 'explicit_decision', false],
    ['explicit_decision', 'explicit_statement', true],
  ];
  for (const [candidateRank, existingRank, allowed] of scenarios) {
    await admin.query(`truncate public.memory_message_processing, public.general_memories,
      public.conversation_messages, public.completed_conversations cascade`);
    await insertConversation(OWNER_A, `authority-base-${candidateRank}-${existingRank}`);
    await insertConversation(OWNER_A, `authority-change-${candidateRank}-${existingRank}`);
    const client = await authenticatedClient(OWNER_A);
    try {
      await commitOne(client, `authority-base-${candidateRank}-${existingRank}`,
        candidate({ provenance: existingRank }), []);
      const expected = await expectedState(client);
      const operation = commitOne(client, `authority-change-${candidateRank}-${existingRank}`,
        candidate({
          action: 'supersede', content: 'The user prefers dim rooms.',
          existingMemoryId: expected[0].id, provenance: candidateRank,
        }), expected);
      if (allowed) await operation;
      else await assert.rejects(operation, (error) => {
        assert.match(error.message, /higher-authority/,
          `${candidateRank} must not replace ${existingRank}`);
        return true;
      });
    } finally {
      await client.end();
    }
  }
});

test('multi-row correction is atomic and a later candidate failure rolls everything back', async () => {
  await insertConversation(OWNER_A, 'atomic-correction');
  await admin.query(`
    insert into public.general_memories (
      owner_id,id,layer,memory_type,subject_key,content,status,confidence,provenance,
      source_references,evidence_count,last_confirmed_at,created_at,updated_at
    ) values
      ($1,'old-a','durable','preference','lighting : brightness','Bright','current',.8,
        'explicit_statement','[]',1,$2,$2,$2),
      ($1,'old-b','durable','preference','LIGHTING/BRIGHTNESS','Dim','ambiguous',.5,
        'inferred','[]',1,$2,$2,$2)
  `, [OWNER_A, NOW]);
  const client = await authenticatedClient(OWNER_A);
  try {
    const expected = await expectedState(client);
    const claimValue = await claim(client, 'atomic-correction');
    await assert.rejects(commit(client, claimValue, { candidates: [
      candidate({ action: 'supersede', content: 'The user prefers soft lighting.', existingMemoryId: 'old-a' }),
      candidate({ memoryType: 'invalid-type', subjectKey: 'later:invalid' }),
    ], version: 1 }, expected), /candidate is invalid/);
    let rows = await admin.query(`select id,status from public.general_memories
      where owner_id = $1 order by id`, [OWNER_A]);
    assert.deepEqual(rows.rows, [{ id: 'old-a', status: 'current' }, { id: 'old-b', status: 'ambiguous' }]);

    await commit(client, claimValue, { candidates: [candidate({
      action: 'supersede', content: 'The user prefers soft lighting.', existingMemoryId: 'old-a',
    })], version: 1 }, expected);
    rows = await admin.query(`select status,count(*)::integer count from public.general_memories
      where owner_id = $1 group by status order by status`, [OWNER_A]);
    assert.deepEqual(rows.rows, [
      { status: 'current', count: 1 }, { status: 'superseded', count: 2 },
    ]);
  } finally {
    await client.end();
  }
});

test('real temporal retrieval distinguishes current, future, stale, and expired rows', async () => {
  await admin.query(`
    insert into public.general_memories (
      owner_id,id,layer,memory_type,subject_key,content,status,confidence,provenance,
      source_references,evidence_count,valid_from,valid_until,stale_after,
      last_confirmed_at,created_at,updated_at
    ) values
      ($1,'current','current_state','state','temporal:lighting','Lighting current','current',.9,'explicit_statement','[]',1,null,null,now()+interval '1 day',now(),now(),now()),
      ($1,'future','current_state','state','temporal:lighting','Lighting future','current',.9,'explicit_statement','[]',1,now()+interval '1 day',now()+interval '2 days',null,now(),now(),now()),
      ($1,'stale','current_state','state','temporal:lighting','Lighting stale','current',.9,'explicit_statement','[]',1,null,null,now()-interval '1 day',now(),now(),now()),
      ($1,'expired','current_state','state','temporal:lighting','Lighting expired','current',.9,'explicit_statement','[]',1,now()-interval '2 days',now()-interval '1 day',null,now(),now(),now())
  `, [OWNER_A]);
  const client = await authenticatedClient(OWNER_A);
  try {
    const current = await client.query(
      "select id,status from public.search_general_memories('lighting','current_state',false,12)",
    );
    assert.deepEqual(current.rows, [{ id: 'current', status: 'current' }]);
    const all = await client.query(
      "select id,status from public.search_general_memories('lighting','current_state',true,12) order by id",
    );
    assert.deepEqual(all.rows, [
      { id: 'current', status: 'current' }, { id: 'expired', status: 'expired' },
      { id: 'future', status: 'stale' }, { id: 'stale', status: 'stale' },
    ]);
  } finally {
    await client.end();
  }
});

test('ambiguous open referents are bounded, age to stale, and outrank unrelated recent facts', async () => {
  await admin.query(`
    insert into public.general_memories (
      owner_id,id,layer,memory_type,subject_key,topic,content,status,confidence,provenance,
      source_references,evidence_count,stale_after,last_confirmed_at,created_at,updated_at
    ) values
      ($1,'linen-open','durable','preference','linen-lampshade-preference','home decor',
        'May be warming to linen lampshades but remains unsure.','ambiguous',.58,'inferred',
        '[]',1,now()+interval '90 days',now(),now(),now()-interval '1 hour'),
      ($1,'linen-aged','durable','preference','old-linen-lampshade-preference','home decor',
        'Was once unsure about old linen lampshades.','ambiguous',.5,'inferred',
        '[]',1,now()-interval '1 day',now(),now()-interval '120 days',now()-interval '120 days'),
      ($1,'recent-a','durable','background','recent-a','general','Recent fact A.','current',.9,
        'explicit_statement','[]',1,null,now(),now(),now()),
      ($1,'recent-b','durable','background','recent-b','general','Recent fact B.','current',.9,
        'explicit_statement','[]',1,null,now(),now(),now()-interval '1 minute'),
      ($1,'recent-c','durable','background','recent-c','general','Recent fact C.','current',.9,
        'explicit_statement','[]',1,null,now(),now(),now()-interval '2 minutes'),
      ($1,'recent-d','durable','background','recent-d','general','Recent fact D.','current',.9,
        'explicit_statement','[]',1,null,now(),now(),now()-interval '3 minutes'),
      ($1,'recent-e','durable','background','recent-e','general','Recent fact E.','current',.9,
        'explicit_statement','[]',1,null,now(),now(),now()-interval '4 minutes')
  `, [OWNER_A]);
  const client = await authenticatedClient(OWNER_A);
  try {
    const context = await client.query(`select id,status from public.get_memory_analysis_context(
      'Actually, I definitely love them now.', 6)`);
    assert.equal(context.rows.length, 6);
    assert.deepEqual(context.rows[0], { id: 'linen-open', status: 'ambiguous' });
    assert.equal(context.rows.some((row) => row.id === 'linen-aged'), false);

    const uncertain = await client.query(`select id,status from public.search_general_memories(
      'linen lampshades', 'durable', true, 12) order by id`);
    assert.deepEqual(uncertain.rows, [
      { id: 'linen-aged', status: 'stale' },
      { id: 'linen-open', status: 'ambiguous' },
    ]);
    const authoritative = await client.query(`select id from public.search_general_memories(
      'linen lampshades', 'durable', false, 12)`);
    assert.deepEqual(authoritative.rows, []);
  } finally {
    await client.end();
  }
});

test('production mug and umbrella wording uses partial fallback without losing ranking precision', async () => {
  await admin.query(`
    insert into public.general_memories (
      owner_id,id,layer,memory_type,subject_key,topic,content,context,status,
      confidence,provenance,source_references,evidence_count,stale_after,
      last_confirmed_at,created_at,updated_at
    ) values
      ($1,'mug-memory','durable','preference','mug-material-finish-preference',
        'mug preference','Prefers matte ceramic mugs over glossy ones.',null,'current',
        .99,'explicit_statement','[]',2,null,now(),now(),now()),
      ($1,'umbrella-memory','current_state','state','borrowed-blue-umbrella-in-possession',
        'personal items','Currently has a blue umbrella borrowed from a cousin.',
        'temporary possession','current',.99,'explicit_statement','[]',1,
        now()+interval '14 days',now(),now(),now()),
      ($1,'mug-distractor','durable','preference','phone-case-finish-preference',
        'phone accessories','Prefers glossy phone cases.',null,'current',.98,
        'explicit_statement','[]',4,null,now(),now(),now()-interval '1 hour'),
      ($1,'umbrella-distractor','current_state','state','cousin-visit',
        'family visit','A cousin is visiting this week.',null,'current',.98,
        'explicit_statement','[]',4,now()+interval '7 days',now(),now(),
        now()-interval '1 hour')
  `, [OWNER_A]);
  const client = await authenticatedClient(OWNER_A);
  try {
    const mug = await client.query(`select id from public.search_general_memories(
      'What kind of mugs do I prefer?', 'durable', false, 10)`);
    assert.equal(mug.rows[0].id, 'mug-memory');

    const umbrellaWording = [
      "Do I still have my cousin's umbrella?",
      'Do I still have my cousins umbrella',
      'Do I still have my cousin umbrella',
      "Do I still have my cousin's umbrellas?",
      'Do I still have my cousins umbrellas',
    ];
    for (const wording of umbrellaWording) {
      const result = await client.query(
        "select id from public.search_general_memories($1,'current_state',false,10)",
        [wording],
      );
      assert.equal(result.rows[0].id, 'umbrella-memory', wording);
    }

    const strong = await client.query(`select id from public.search_general_memories(
      'matte ceramic mug preference', 'durable', false, 10)`);
    assert.deepEqual(strong.rows.map((row) => row.id), ['mug-memory']);
  } finally {
    await client.end();
  }
});

test('nonretryable failed checkpoints stay actionable while transient failures remain retryable', async () => {
  await insertConversation(OWNER_A, 'terminal-failure');
  const client = await authenticatedClient(OWNER_A);
  try {
    const first = await claim(client, 'terminal-failure');
    await client.query('select public.fail_memory_message($1,$2,$3,$4)', [
      first.context.conversationId, first.context.message.id, first.claimToken,
      '[nonretryable] The referenced memory has a different logical identity.',
    ]);
    assert.equal((await claim(client, 'terminal-failure')).status, 'complete');
    const terminal = await admin.query(`select status,processing_attempts,last_error
      from public.memory_message_processing where owner_id = $1`, [OWNER_A]);
    assert.equal(terminal.rows[0].status, 'failed');
    assert.equal(terminal.rows[0].processing_attempts, 1);
    assert.match(terminal.rows[0].last_error, /^\[nonretryable\]/);

    await insertConversation(OWNER_A, 'transient-failure');
    const transient = await claim(client, 'transient-failure');
    await client.query('select public.fail_memory_message($1,$2,$3,$4)', [
      transient.context.conversationId, transient.context.message.id,
      transient.claimToken, 'Temporary network failure.',
    ]);
    const retry = await claim(client, 'transient-failure');
    assert.equal(retry.status, 'claimed');
    const attempts = await admin.query(`select processing_attempts from public.memory_message_processing
      where owner_id = $1 and conversation_id = 'transient-failure'`, [OWNER_A]);
    assert.equal(attempts.rows[0].processing_attempts, 2);
  } finally {
    await client.end();
  }
});

test('a completed backlog beyond 256 messages remains discoverable and fully drains later', async () => {
  // The established conversation API caps ordinary transcripts at 50. Seed an
  // oversized completed transcript directly to stress only memory continuation.
  await insertConversation(OWNER_A, 'large-completed', 265, true);
  const client = await authenticatedClient(OWNER_A);
  try {
    let firstExecution = 0;
    for (let request = 0; request < 32; request += 1) {
      const drained = await drainMessages(client, 8);
      firstExecution += drained.processed;
      assert.equal(drained.complete, false);
    }
    assert.equal(firstExecution, 256);
    const remaining = await admin.query(`
      select count(*)::integer count from public.conversation_messages messages
      left join public.memory_message_processing checkpoints
        on checkpoints.owner_id = messages.owner_id and checkpoints.message_id = messages.id
      where messages.owner_id = $1 and coalesce(checkpoints.status, '') <> 'processed'
    `, [OWNER_A]);
    assert.equal(remaining.rows[0].count, 9);

    const continuation = await drainMessages(client, 16);
    assert.equal(continuation.complete, true);
    assert.equal(continuation.processed, 9);
    const processed = await admin.query(`select count(*)::integer count
      from public.memory_message_processing where owner_id = $1 and status = 'processed'`, [OWNER_A]);
    assert.equal(processed.rows[0].count, 265);
  } finally {
    await client.end();
  }
});

test('database RPCs isolate claims, commits, provenance, and retrieval across owners', async () => {
  await insertConversation(OWNER_A, 'owner-a-conversation');
  const ownerA = await authenticatedClient(OWNER_A);
  const ownerB = await authenticatedClient(OWNER_B);
  try {
    const ownerAClaim = await claim(ownerA, 'owner-a-conversation');
    assert.equal((await claim(ownerB, 'owner-a-conversation')).status, 'complete');
    await assert.rejects(commit(ownerB, ownerAClaim, { candidates: [candidate()], version: 1 }),
      /claim is stale/);
    await commit(ownerA, ownerAClaim, { candidates: [candidate()], version: 1 });
    const ownerBSearch = await ownerB.query(
      "select * from public.search_general_memories('lighting','any',true,12)",
    );
    assert.equal(ownerBSearch.rowCount, 0);
    const source = await admin.query(`select source_references from public.general_memories
      where owner_id = $1`, [OWNER_A]);
    assert.equal(source.rows[0].source_references[0].conversation_id, 'owner-a-conversation');
  } finally {
    await ownerA.end();
    await ownerB.end();
  }
});
