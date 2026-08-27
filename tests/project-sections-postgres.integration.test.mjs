import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import EmbeddedPostgres from 'embedded-postgres';
import pgPackage from 'pg';

const { Client } = pgPackage;
const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROOT = path.resolve(import.meta.dirname, '..');
const SECTION_MIGRATION = '20260826120000_create_project_sections.sql';
const ASSET_MIGRATION = '20260826170000_add_project_assets.sql';
const AT = '2026-08-26T16:00:00.000Z';

let admin;
let databaseDir;
let databasePort;
let embedded;

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
    database: 'postgres', host: '127.0.0.1', password: 'sections-test',
    port: databasePort, user: 'postgres',
  });
  await client.connect();
  await client.query('set role authenticated');
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  return client;
}

async function insertProject(ownerId, id) {
  await admin.query(`
    insert into public.projects (
      owner_id,id,created_at,name,priority,status,timezone,type,updated_at
    ) values ($1,$2,$3,$2,'normal','active','America/Toronto','general',$3)
  `, [ownerId, id, AT]);
}

async function insertCustomSection(ownerId, projectId, id, title, position) {
  await admin.query(`
    insert into public.project_sections (
      owner_id,id,created_at,is_default,position,project_id,status,title,updated_at
    ) values ($1,$2,$3,false,$4,$5,'active',$6,$3)
  `, [ownerId, id, AT, position, projectId, title]);
}

before(async () => {
  databaseDir = await mkdtemp(path.join(os.tmpdir(), 'tina-sections-postgres-'));
  databasePort = await availablePort();
  embedded = new EmbeddedPostgres({
    databaseDir, password: 'sections-test', persistent: false, port: databasePort,
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
  const migrations = (await readdir(migrationDir))
    .filter((name) => name.endsWith('.sql') && name !== SECTION_MIGRATION && name !== ASSET_MIGRATION)
    .sort();
  for (const migration of migrations) {
    await admin.query(await readFile(path.join(migrationDir, migration), 'utf8'));
  }

  await insertProject(OWNER_A, 'existing-a');
  await insertProject(OWNER_A, 'other-a');
  await insertProject(OWNER_B, 'existing-b');
  await admin.query(`
    insert into public.project_tasks (
      owner_id,id,created_at,position,priority,project_id,status,title,updated_at
    ) values ($1,'untouched-task',$2,0,'normal','existing-a','todo','Keep me',$2)
  `, [OWNER_A, AT]);
  await admin.query(await readFile(path.join(migrationDir, SECTION_MIGRATION), 'utf8'));
});

after(async () => {
  await admin?.end();
  await embedded?.stop();
  if (databaseDir) await rm(databaseDir, { force: true, recursive: true });
});

test('migration backfills exactly one deterministic Overview per existing owned Project', async () => {
  const rows = (await admin.query(`
    select owner_id::text owner_id, id, is_default, position, project_id, status, title
    from public.project_sections order by owner_id, project_id
  `)).rows;
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.id, `project-section-overview:${row.project_id}`);
    assert.equal(row.is_default, true);
    assert.equal(row.position, 0);
    assert.equal(row.status, 'active');
    assert.equal(row.title, 'Overview');
  }

  const owner = await authenticatedClient(OWNER_A);
  try {
    await owner.query('select public.commit_project_changes($1::jsonb)', [JSON.stringify({
      sections: [{
        created_at: AT, id: 'project-section-overview:existing-a', is_default: true,
        position: 0, project_id: 'existing-a', status: 'active', title: 'Overview',
        updated_at: AT,
      }],
    })]);
    const count = await owner.query(`select count(*)::integer count
      from public.project_sections where project_id = 'existing-a' and is_default`);
    assert.equal(count.rows[0].count, 1);
  } finally {
    await owner.end();
  }
});

test('RLS and composite ownership prevent cross-owner section reads and creation', async () => {
  const ownerA = await authenticatedClient(OWNER_A);
  const ownerB = await authenticatedClient(OWNER_B);
  try {
    const own = await ownerA.query(`select id from public.project_sections
      where project_id = 'existing-a'`);
    const hidden = await ownerB.query(`select id from public.project_sections
      where project_id = 'existing-a'`);
    assert.equal(own.rowCount, 1);
    assert.equal(hidden.rowCount, 0);

    await assert.rejects(ownerB.query(`
      insert into public.project_sections (
        id,created_at,is_default,position,project_id,status,title,updated_at
      ) values ('foreign-write',$1,false,1,'existing-a','active','Foreign',$1)
    `, [AT]), /violates foreign key constraint|row-level security/i);
    assert.equal((await admin.query(`select count(*)::integer count
      from public.project_sections where id = 'foreign-write'`)).rows[0].count, 0);
  } finally {
    await ownerA.end();
    await ownerB.end();
  }
});

test('section identity, Overview protection, and active-title uniqueness are database-enforced', async () => {
  await insertCustomSection(OWNER_A, 'existing-a', 'materials-a', 'Materials', 1);
  const owner = await authenticatedClient(OWNER_A);
  try {
    await assert.rejects(owner.query(`update public.project_sections
      set project_id = 'other-a' where id = 'materials-a'`), /immutable/i);
    await assert.rejects(owner.query(`update public.project_sections
      set status = 'archived' where id = 'project-section-overview:existing-a'`), /check constraint/i);
    await assert.rejects(owner.query(`
      insert into public.project_sections (
        id,created_at,is_default,position,project_id,status,title,updated_at
      ) values ('materials-duplicate',$1,false,2,'existing-a','active','materials',$1)
    `, [AT]), /project_sections_active_title_idx/i);
  } finally {
    await owner.end();
  }
});

test('reorder is atomic, deterministic, owner-scoped, and rejects cross-Project IDs', async () => {
  await insertCustomSection(OWNER_A, 'existing-a', 'budget-a', 'Budget', 2);
  await insertCustomSection(OWNER_A, 'other-a', 'other-section-a', 'Characters', 1);
  const owner = await authenticatedClient(OWNER_A);
  const other = await authenticatedClient(OWNER_B);
  const overview = 'project-section-overview:existing-a';
  try {
    const reordered = await owner.query(
      'select id,position from public.reorder_project_sections($1,$2,$3) order by position',
      ['existing-a', [overview, 'budget-a', 'materials-a'], '2026-08-26T17:00:00.000Z'],
    );
    assert.deepEqual(reordered.rows.map(({ id, position }) => [id, position]), [
      [overview, 0], ['budget-a', 1], ['materials-a', 2],
    ]);

    await assert.rejects(owner.query(
      'select * from public.reorder_project_sections($1,$2,$3)',
      ['existing-a', [overview, 'budget-a', 'other-section-a'], AT],
    ), /every active section/i);
    await assert.rejects(other.query(
      'select * from public.reorder_project_sections($1,$2,$3)',
      ['existing-a', [overview, 'budget-a', 'materials-a'], AT],
    ), /Project was not found/i);

    const stillOrdered = await owner.query(`select id,position from public.project_sections
      where project_id = 'existing-a' and status = 'active' order by position,id`);
    assert.deepEqual(stillOrdered.rows.map(({ id, position }) => [id, position]), [
      [overview, 0], ['budget-a', 1], ['materials-a', 2],
    ]);
  } finally {
    await owner.end();
    await other.end();
  }
});

test('section migration and operations leave existing Project domain rows untouched', async () => {
  const task = await admin.query(`select title,status,position from public.project_tasks
    where owner_id = $1 and id = 'untouched-task'`, [OWNER_A]);
  assert.deepEqual(task.rows, [{ position: 0, status: 'todo', title: 'Keep me' }]);
});
