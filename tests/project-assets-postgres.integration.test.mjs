import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import EmbeddedPostgres from 'embedded-postgres';
import pgPackage from 'pg';

const { Client } = pgPackage;
const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-08-26T17:00:00.000Z';
const ROOT = path.resolve(import.meta.dirname, '..');
let admin;
let databaseDir;
let databasePort;
let embedded;

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function client(ownerId) {
  const value = new Client({ database: 'postgres', host: '127.0.0.1', password: 'assets-test', port: databasePort, user: 'postgres' });
  await value.connect();
  await value.query('set role authenticated');
  await value.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  return value;
}

async function migrate(name) {
  await admin.query(await readFile(path.join(ROOT, 'supabase', 'migrations', name), 'utf8'));
}

before(async () => {
  databaseDir = await mkdtemp(path.join(os.tmpdir(), 'tina-assets-postgres-'));
  databasePort = await availablePort();
  embedded = new EmbeddedPostgres({ databaseDir, password: 'assets-test', persistent: false, port: databasePort, user: 'postgres', onError: () => undefined, onLog: () => undefined });
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
    create schema storage;
    create table storage.buckets (
      id text primary key, name text not null, public boolean not null default false,
      file_size_limit bigint, allowed_mime_types text[]
    );
    create table storage.objects (
      id bigint generated always as identity primary key,
      bucket_id text not null references storage.buckets(id), name text not null,
      unique(bucket_id, name)
    );
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select, insert, delete on storage.objects to authenticated;
  `);
  await migrate('20260813150000_create_project_persistence.sql');
  await admin.query(`
    insert into public.projects(owner_id,id,created_at,name,priority,status,timezone,type,updated_at) values
      ('${OWNER_A}','aqal','${AT}','AQAL','normal','active','America/Toronto','general','${AT}'),
      ('${OWNER_A}','other-a','${AT}','Other A','normal','active','America/Toronto','general','${AT}'),
      ('${OWNER_B}','other-b','${AT}','Other B','normal','active','America/Toronto','general','${AT}');
    insert into public.project_resources(owner_id,id,created_at,external_url,name,project_id,role,type,updated_at)
      values ('${OWNER_A}','legacy-link','${AT}','https://example.com','Existing link','aqal','reference','link','${AT}');
  `);
  await migrate('20260826120000_create_project_sections.sql');
  await admin.query(`
    insert into public.project_sections(owner_id,id,created_at,is_default,position,project_id,status,title,updated_at) values
      ('${OWNER_A}','materials','${AT}',false,1,'aqal','active','Materials','${AT}'),
      ('${OWNER_A}','notes','${AT}',false,2,'aqal','active','Notes','${AT}'),
      ('${OWNER_A}','other-a-section','${AT}',false,1,'other-a','active','Other','${AT}'),
      ('${OWNER_B}','other-b-section','${AT}',false,1,'other-b','active','Other','${AT}');
  `);
  await migrate('20260826170000_add_project_assets.sql');
});

after(async () => {
  await admin?.end();
  await embedded?.stop();
  if (databaseDir) await rm(databaseDir, { force: true, recursive: true });
});

async function reserve(connection, id, overrides = {}) {
  const values = {
    assetId: `asset-${id}`, attemptId: `attempt-${id}`, byteSize: 4, height: 800,
    mimeType: 'image/png', objectId: `object-${id}`, originalFilename: `${id}.png`,
    projectId: 'aqal', sectionId: 'materials', sourcePicker: 'photo-library', width: 1200,
    ...overrides,
  };
  const result = await connection.query(`select public.begin_project_asset_upload(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
  ) value`, [values.attemptId, values.assetId, values.objectId, values.projectId,
    values.sectionId, values.originalFilename, values.mimeType, values.byteSize,
    values.sourcePicker, values.width, values.height]);
  return result.rows[0].value;
}

async function store(connection, objectPath) {
  await connection.query(`insert into storage.objects(bucket_id,name)
    values ('project-assets',$1)`, [objectPath]);
}

async function finalize(connection, attemptId) {
  return (await connection.query(`select * from public.finalize_project_asset_upload($1)`, [attemptId])).rows[0];
}

test('migration preserves legacy semantics and configures a private bounded bucket', async () => {
  const legacy = (await admin.query(`select resource_kind,status,storage_path,section_id,source_metadata
    from public.project_resources where id='legacy-link'`)).rows[0];
  assert.deepEqual(legacy, { resource_kind: 'legacy', section_id: null, source_metadata: {}, status: 'current', storage_path: null });
  const bucket = (await admin.query(`select public,file_size_limit,allowed_mime_types
    from storage.buckets where id='project-assets'`)).rows[0];
  assert.equal(bucket.public, false);
  assert.equal(Number(bucket.file_size_limit), 26214400);
  assert.ok(bucket.allowed_mime_types.includes('application/pdf'));
});

test('finalization refuses metadata until the exact reserved Storage object exists and is idempotent', async () => {
  const owner = await client(OWNER_A);
  try {
    const attempt = await reserve(owner, 'exact');
    await assert.rejects(finalize(owner, attempt.attempt_id), /exact reserved Storage object/i);
    assert.equal((await owner.query(`select id from public.project_resources where id=$1`, [attempt.asset_id])).rowCount, 0);
    await store(owner, attempt.storage_path);
    const first = await finalize(owner, attempt.attempt_id);
    const second = await finalize(owner, attempt.attempt_id);
    assert.equal(first.id, attempt.asset_id);
    assert.equal(second.id, first.id);
    assert.equal((await owner.query(`select id from public.project_resources where id=$1`, [first.id])).rowCount, 1);
  } finally { await owner.end(); }
});

test('opening an active section reconciles a crash-left pending object exactly once', async () => {
  const owner = await client(OWNER_A);
  try {
    const attempt = await reserve(owner, 'crash-recovery');
    await store(owner, attempt.storage_path);
    await owner.query(`select public.reconcile_project_asset_uploads('aqal','materials')`);
    assert.equal((await owner.query(`select id from public.project_resources where id=$1`, [attempt.asset_id])).rowCount, 1);
    await owner.query(`select public.reconcile_project_asset_uploads('aqal','materials')`);
    assert.equal((await owner.query(`select id from public.project_resources where id=$1`, [attempt.asset_id])).rowCount, 1);
  } finally { await owner.end(); }
});

test('paths require exactly four non-empty components and exact owner/Project/asset/object identities', async () => {
  const ownerA = await client(OWNER_A);
  const ownerB = await client(OWNER_B);
  try {
    const attempt = await reserve(ownerA, 'paths');
    const candidates = [
      `${OWNER_A}/aqal/${attempt.asset_id}`,
      `${OWNER_A}/aqal/${attempt.asset_id}//${attempt.object_id}`,
      `${OWNER_A}/aqal/${attempt.asset_id}/${attempt.object_id}/extra`,
      `${OWNER_B}/aqal/${attempt.asset_id}/${attempt.object_id}`,
      `${OWNER_A}/other-a/${attempt.asset_id}/${attempt.object_id}`,
      `${OWNER_A}/aqal/forged-asset/${attempt.object_id}`,
      `${OWNER_A}/aqal/${attempt.asset_id}/forged-object`,
    ];
    for (const candidate of candidates) {
      assert.equal((await admin.query(`select private.project_asset_path_matches($1,$2,$3,$4,$5) ok`,
        [candidate, OWNER_A, 'aqal', attempt.asset_id, attempt.object_id])).rows[0].ok, false);
      await assert.rejects(store(ownerA, candidate), /row-level security/i);
    }
    await assert.rejects(store(ownerB, attempt.storage_path), /row-level security/i);
    await store(ownerA, attempt.storage_path);
  } finally { await ownerA.end(); await ownerB.end(); }
});

test('pending upload and finalized read policies are exact and cross-owner isolated', async () => {
  const ownerA = await client(OWNER_A);
  const ownerB = await client(OWNER_B);
  try {
    const attempt = await reserve(ownerA, 'read');
    await store(ownerA, attempt.storage_path);
    assert.equal((await ownerA.query(`select name from storage.objects where name=$1`, [attempt.storage_path])).rowCount, 1);
    assert.equal((await ownerB.query(`select name from storage.objects where name=$1`, [attempt.storage_path])).rowCount, 0);
    await finalize(ownerA, attempt.attempt_id);
    assert.equal((await ownerA.query(`select name from storage.objects where name=$1`, [attempt.storage_path])).rowCount, 1);
    assert.equal((await ownerB.query(`select id from public.project_resources where id=$1`, [attempt.asset_id])).rowCount, 0);
    await assert.rejects(store(ownerA, `${OWNER_A}/aqal/unreserved/object`), /row-level security/i);
  } finally { await ownerA.end(); await ownerB.end(); }
});

test('pending attempts cannot forge another owner, Project, section, asset, or object identity', async () => {
  const ownerA = await client(OWNER_A);
  const ownerB = await client(OWNER_B);
  try {
    await assert.rejects(reserve(ownerB, 'foreign-owner', {
      projectId: 'aqal', sectionId: 'materials',
    }), /active section|foreign key/i);
    await assert.rejects(reserve(ownerA, 'foreign-project', {
      projectId: 'other-a', sectionId: 'materials',
    }), /active section|foreign key/i);
    await assert.rejects(reserve(ownerA, 'foreign-section', {
      sectionId: 'other-a-section',
    }), /active section|foreign key/i);
    const attempt = await reserve(ownerA, 'stable-attempt');
    await assert.rejects(reserve(ownerA, 'stable-attempt', {
      assetId: 'forged-asset',
    }), /immutable/i);
    await assert.rejects(reserve(ownerA, 'stable-attempt', {
      objectId: 'forged-object',
    }), /immutable/i);
    assert.match(attempt.storage_path, new RegExp(`/${attempt.asset_id}/${attempt.object_id}$`));
  } finally { await ownerA.end(); await ownerB.end(); }
});

test('cleanup policy permits only the exact pending object and cannot remove a finalized object', async () => {
  const owner = await client(OWNER_A);
  try {
    const pending = await reserve(owner, 'cleanup');
    await store(owner, pending.storage_path);
    // This DELETE emulates Storage API policy evaluation; application cleanup uses storage.remove().
    assert.equal((await owner.query(`delete from storage.objects where name=$1`, [pending.storage_path])).rowCount, 1);
    await owner.query(`select public.mark_project_asset_upload_cleaned($1)`, [pending.attempt_id]);
    const finalized = await reserve(owner, 'keep');
    await store(owner, finalized.storage_path);
    await finalize(owner, finalized.attempt_id);
    assert.equal((await owner.query(`delete from storage.objects where name=$1`, [finalized.storage_path])).rowCount, 0);
    await assert.rejects(owner.query(`select public.mark_project_asset_upload_cleaned($1)`, [finalized.attempt_id]), /finalized/i);
  } finally { await owner.end(); }
});

test('original binary identity is immutable while label, status, and same-Project section remain editable', async () => {
  const owner = await client(OWNER_A);
  try {
    const attempt = await reserve(owner, 'immutable');
    await store(owner, attempt.storage_path);
    await finalize(owner, attempt.attempt_id);
    for (const mutation of [
      `mime_type='image/jpeg'`, `byte_size=5`, `original_filename='other.png'`,
      `storage_path='${OWNER_A}/aqal/${attempt.asset_id}/replacement'`,
      `source_metadata='{"kind":"changed"}'::jsonb`, `width=1000`, `resource_kind='legacy'`,
    ]) await assert.rejects(owner.query(`update public.project_resources set ${mutation}
      where id=$1`, [attempt.asset_id]), /immutable|check constraint/i);
    await owner.query(`update public.project_resources set name='Editable label',status='archived',
      section_id='notes' where id=$1`, [attempt.asset_id]);
    const row = (await owner.query(`select name,status,section_id,storage_path
      from public.project_resources where id=$1`, [attempt.asset_id])).rows[0];
    assert.deepEqual(row, { name: 'Editable label', section_id: 'notes', status: 'archived', storage_path: attempt.storage_path });
    await assert.rejects(owner.query(`update public.project_resources set section_id='other-a-section'
      where id=$1`, [attempt.asset_id]), /active section|foreign key/i);
  } finally { await owner.end(); }
});

test('legacy writes remain valid while partial/direct uploaded rows are rejected', async () => {
  const owner = await client(OWNER_A);
  try {
    await owner.query(`insert into public.project_resources(id,created_at,external_url,name,project_id,role,type,updated_at)
      values ('legacy-two',$1,'https://example.org','Legacy two','aqal','reference','link',$1)`, [AT]);
    await assert.rejects(owner.query(`insert into public.project_resources(
      id,byte_size,created_at,mime_type,name,original_filename,project_id,resource_kind,role,
      section_id,source_metadata,status,storage_path,type,updated_at,width,height
    ) values ('direct-asset',4,$1,'image/png','Direct','direct.png','aqal','uploaded_asset',
      'reference','materials','{"kind":"original-upload","picker":"photo-library"}','current',
      $2,'image',$1,100,100)`, [AT, `${OWNER_A}/aqal/direct-asset/object`]), /row-level security/i);
    await assert.rejects(owner.query(`update public.project_resources set byte_size=4
      where id='legacy-two'`), /check constraint/i);
  } finally { await owner.end(); }
});

test('SECURITY DEFINER upload functions derive auth identity and use safe search paths', async () => {
  const definitions = (await admin.query(`select proname,prosecdef,proconfig
    from pg_proc join pg_namespace on pg_namespace.oid=pronamespace
    where nspname in ('public','private') and proname in (
      'begin_project_asset_upload','finalize_project_asset_upload',
      'mark_project_asset_upload_cleaned','can_upload_project_asset_object',
      'can_read_project_asset_object','can_delete_pending_project_asset_object',
      'project_asset_storage_object_exists','validate_project_asset_relationships'
      ,'reconcile_project_asset_uploads'
    ) order by proname`)).rows;
  assert.equal(definitions.length, 9);
  assert.ok(definitions.every((row) => row.prosecdef && row.proconfig.includes('search_path=""')));
  const unauthenticated = new Client({ database: 'postgres', host: '127.0.0.1', password: 'assets-test', port: databasePort, user: 'postgres' });
  await unauthenticated.connect();
  try {
    await unauthenticated.query('set role authenticated');
    await assert.rejects(reserve(unauthenticated, 'anon'), /authentication|active section/i);
  } finally { await unauthenticated.end(); }
});
