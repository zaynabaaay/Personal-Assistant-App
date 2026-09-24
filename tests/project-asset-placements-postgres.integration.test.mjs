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
const AT = '2026-09-03T12:00:00.000Z';
const ROOT = path.resolve(import.meta.dirname, '..');
const PLACEMENT_MIGRATION = '20260903120000_add_project_asset_section_placements.sql';
const MULTI_PLACEMENT_MIGRATION = '20260908120000_add_project_asset_multi_placements.sql';
const GLOBAL_ASSET_MIGRATION = '20260920120000_enable_project_global_assets.sql';
let admin;
let databaseDir;
let databasePort;
let embedded;
let resourcesBeforeBackfill;

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

async function client(ownerId) {
  const value = new Client({
    database: 'postgres', host: '127.0.0.1', password: 'placements-test',
    port: databasePort, user: 'postgres',
  });
  await value.connect();
  await value.query('set role authenticated');
  await value.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  return value;
}

async function migrate(name) {
  await admin.query(await readFile(path.join(ROOT, 'supabase', 'migrations', name), 'utf8'));
}

async function reserve(connection, id, overrides = {}) {
  const value = {
    assetId: `asset-${id}`, attemptId: `attempt-${id}`, byteSize: 4, height: 1,
    mimeType: 'image/png', objectId: `object-${id}`, originalFilename: `${id}.png`,
    projectId: 'aqal', sectionId: 'materials', sourcePicker: 'photo-library', width: 1,
    ...overrides,
  };
  return (await connection.query(`select public.begin_project_asset_upload(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
  ) value`, [value.attemptId, value.assetId, value.objectId, value.projectId,
    value.sectionId, value.originalFilename, value.mimeType, value.byteSize,
    value.sourcePicker, value.width, value.height])).rows[0].value;
}

async function store(connection, storagePath) {
  await connection.query(
    "insert into storage.objects(bucket_id,name) values ('project-assets',$1)",
    [storagePath],
  );
}

async function finalize(connection, attemptId) {
  return (await connection.query(
    'select * from public.finalize_project_asset_upload($1)', [attemptId],
  )).rows[0];
}

async function createFinalized(connection, id, overrides = {}) {
  const attempt = await reserve(connection, id, overrides);
  await store(connection, attempt.storage_path);
  return finalize(connection, attempt.attempt_id);
}

async function assertStillPending(operation, label) {
  let settled = false;
  void operation.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false, `${label} should wait for the conflicting section lock`);
}

before(async () => {
  databaseDir = await mkdtemp(path.join(os.tmpdir(), 'tina-placements-postgres-'));
  databasePort = await availablePort();
  embedded = new EmbeddedPostgres({
    databaseDir, password: 'placements-test', persistent: false, port: databasePort,
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
      ('${OWNER_A}','archive-later','${AT}',false,3,'aqal','active','Archive later','${AT}'),
      ('${OWNER_A}','fallback-a','${AT}',false,4,'aqal','active','Fallback A','${AT}'),
      ('${OWNER_A}','fallback-b','${AT}',false,5,'aqal','active','Fallback B','${AT}'),
      ('${OWNER_A}','other-a-section','${AT}',false,1,'other-a','active','Other A section','${AT}'),
      ('${OWNER_B}','other-b-section','${AT}',false,1,'other-b','active','Other B section','${AT}');
  `);
  await migrate('20260826170000_add_project_assets.sql');

  const owner = await client(OWNER_A);
  try {
    await createFinalized(owner, 'existing-current');
    const archived = await createFinalized(owner, 'existing-archived');
    await owner.query("update public.project_resources set status='archived' where id=$1", [archived.id]);
    await createFinalized(owner, 'existing-archived-section', { sectionId: 'archive-later' });
    await owner.query("update public.project_sections set status='archived' where id='archive-later'");
    await reserve(owner, 'pending');
  } finally {
    await owner.end();
  }

  resourcesBeforeBackfill = (await admin.query(`select id,owner_id,project_id,section_id,
    status,storage_path,original_filename,mime_type,byte_size,width,height,source_metadata,
    created_at,updated_at from public.project_resources order by id`)).rows;
  await migrate(PLACEMENT_MIGRATION);
  await migrate(MULTI_PLACEMENT_MIGRATION);
  await migrate(GLOBAL_ASSET_MIGRATION);
});

after(async () => {
  await admin?.end();
  await embedded?.stop();
  if (databaseDir) await rm(databaseDir, { force: true, recursive: true });
});

test('placement schema uses composite owned-Project integrity and an owner-read-only boundary', async () => {
  const constraints = (await admin.query(`select conname, pg_get_constraintdef(oid) definition
    from pg_constraint where conrelid='public.project_asset_section_placements'::regclass
    order by conname`)).rows;
  const definitions = constraints.map((row) => row.definition).join('\n');
  assert.match(definitions, /PRIMARY KEY \(owner_id, project_id, asset_id, section_id\)/);
  assert.doesNotMatch(definitions, /UNIQUE \(owner_id, project_id, asset_id\)/);
  assert.match(definitions, /FOREIGN KEY \(owner_id, project_id, asset_id\).*project_resources\(owner_id, project_id, id\)/);
  assert.match(definitions, /FOREIGN KEY \(owner_id, project_id, section_id\).*project_sections\(owner_id, project_id, id\)/);

  const owner = await client(OWNER_A);
  try {
    assert.ok((await owner.query('select * from public.project_asset_section_placements')).rowCount > 0);
    await assert.rejects(owner.query(`insert into public.project_asset_section_placements(
      project_id,asset_id,section_id) values ('aqal','asset-existing-current','notes')`),
    /permission denied|row-level security/i);
  } finally {
    await owner.end();
  }
  const otherOwner = await client(OWNER_B);
  try {
    assert.equal((await otherOwner.query('select * from public.project_asset_section_placements')).rowCount, 0);
  } finally {
    await otherOwner.end();
  }
});

test('backfill creates exactly one matching placement without changing asset identity or metadata', async () => {
  const resourcesAfter = (await admin.query(`select id,owner_id,project_id,section_id,
    status,storage_path,original_filename,mime_type,byte_size,width,height,source_metadata,
    created_at,updated_at from public.project_resources order by id`)).rows;
  assert.deepEqual(resourcesAfter, resourcesBeforeBackfill);

  const placements = (await admin.query(`select asset_id,section_id from
    public.project_asset_section_placements order by asset_id`)).rows;
  assert.deepEqual(placements, [
    { asset_id: 'asset-existing-archived', section_id: 'materials' },
    { asset_id: 'asset-existing-archived-section', section_id: 'archive-later' },
    { asset_id: 'asset-existing-current', section_id: 'materials' },
  ]);
  assert.equal((await admin.query(`select 1 from public.project_asset_section_placements
    where asset_id='legacy-link'`)).rowCount, 0);
  assert.equal((await admin.query(`select 1 from public.project_asset_section_placements
    where asset_id='asset-pending'`)).rowCount, 0);
});

test('placement and Project-global reads are deterministic, resource-driven, and equivalent', async () => {
  const owner = await client(OWNER_A);
  try {
    assert.deepEqual((await owner.query(`select asset_id,section_id,created_at
      from public.project_asset_section_placements
      where project_id='aqal' and asset_id='asset-existing-current'
      order by created_at,section_id`)).rows.map(({ asset_id, section_id }) => ({ asset_id, section_id })), [
      { asset_id: 'asset-existing-current', section_id: 'materials' },
    ]);

    const placementIds = (await owner.query(`select asset_id
      from public.project_asset_section_placements
      where project_id='aqal' and section_id='materials'
      order by created_at,asset_id`)).rows.map(({ asset_id }) => asset_id).sort();
    const directIds = (await owner.query(`select id
      from public.project_resources
      where project_id='aqal' and resource_kind='uploaded_asset' and section_id='materials'
      order by created_at,id`)).rows.map(({ id }) => id).sort();
    assert.deepEqual(placementIds, directIds);

    const globalAssets = (await owner.query(`select
      byte_size,created_at,description,height,id,mime_type,name,original_filename,
      project_id,resource_kind,role,source_metadata,source_session_id,status,type,
      updated_at,width
      from public.project_resources
      where project_id='aqal' and resource_kind='uploaded_asset'
      order by created_at,id`)).rows;
    assert.equal(globalAssets.some((row) => row.id === 'legacy-link'), false);
    assert.equal(globalAssets.some((row) => row.status === 'archived'), true);
    assert.equal(new Set(globalAssets.map(({ id }) => id)).size, globalAssets.length);
    assert.equal(globalAssets.some((row) => 'storage_path' in row), false);
    assert.deepEqual(globalAssets.map(({ id }) => id), [
      'asset-existing-current',
      'asset-existing-archived',
      'asset-existing-archived-section',
    ]);
  } finally {
    await owner.end();
  }
});

test('backfill can rerun without duplicates and validates the exact legacy relationship', async () => {
  const before = Number((await admin.query(
    'select count(*) count from public.project_asset_section_placements',
  )).rows[0].count);
  await admin.query('select private.backfill_project_asset_section_placements()');
  await admin.query('select private.backfill_project_asset_section_placements()');
  const afterCount = Number((await admin.query(
    'select count(*) count from public.project_asset_section_placements',
  )).rows[0].count);
  assert.equal(afterCount, before);
  const invalid = await admin.query(`select resources.id
    from public.project_resources resources
    left join public.project_asset_section_placements placements
      on placements.owner_id=resources.owner_id and placements.project_id=resources.project_id
      and placements.asset_id=resources.id
    where resources.resource_kind='uploaded_asset'
    group by resources.id,resources.section_id
    having count(placements.asset_id)<>1
      or bool_or(placements.section_id is distinct from resources.section_id)`);
  assert.equal(invalid.rowCount, 0);
});

test('successful finalization atomically creates one matching placement and retry is idempotent', async () => {
  const owner = await client(OWNER_A);
  try {
    const attempt = await reserve(owner, 'new-upload');
    await assert.rejects(finalize(owner, attempt.attempt_id), /exact reserved Storage object/i);
    assert.equal((await owner.query('select id from public.project_resources where id=$1', [attempt.asset_id])).rowCount, 0);
    assert.equal((await owner.query('select asset_id from public.project_asset_section_placements where asset_id=$1', [attempt.asset_id])).rowCount, 0);

    await store(owner, attempt.storage_path);
    const first = await finalize(owner, attempt.attempt_id);
    const second = await finalize(owner, attempt.attempt_id);
    assert.equal(second.id, first.id);
    const placements = (await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1`, [first.id])).rows;
    assert.deepEqual(placements, [{ section_id: 'materials' }]);
    assert.equal((await owner.query(`select status from public.project_asset_upload_attempts
      where attempt_id=$1`, [attempt.attempt_id])).rows[0].status, 'finalized');
  } finally {
    await owner.end();
  }
});

test('Project-level finalization and reconciliation remain sectionless and idempotent', async () => {
  const owner = await client(OWNER_A);
  try {
    const attempt = await reserve(owner, 'project-global', { sectionId: null });
    await store(owner, attempt.storage_path);
    const first = await finalize(owner, attempt.attempt_id);
    const retriedReservation = await reserve(owner, 'project-global', { sectionId: null });
    const second = await finalize(owner, retriedReservation.attempt_id);
    assert.equal(second.id, first.id);
    assert.equal(first.section_id, null);
    assert.equal((await owner.query(`select count(*) count
      from public.project_asset_section_placements where asset_id=$1`, [first.id])).rows[0].count, '0');

    const pending = await reserve(owner, 'project-global-reconcile', { sectionId: null });
    await store(owner, pending.storage_path);
    await owner.query('select public.reconcile_project_asset_uploads($1,$2)', ['aqal', null]);
    await owner.query('select public.reconcile_project_asset_uploads($1,$2)', ['aqal', null]);
    const reconciled = (await owner.query(`select id,section_id,status from public.project_resources
      where id=$1`, [pending.asset_id])).rows;
    assert.deepEqual(reconciled, [{ id: pending.asset_id, section_id: null, status: 'current' }]);
    assert.equal((await owner.query(`select count(*) count
      from public.project_asset_section_placements where asset_id=$1`, [pending.asset_id])).rows[0].count, '0');
  } finally { await owner.end(); }
});

test('first Add and final Remove atomically maintain the compatibility designation', async () => {
  const owner = await client(OWNER_A);
  try {
    const asset = await createFinalized(owner, 'zero-to-one-to-zero', { sectionId: null });
    const storagePath = asset.storage_path;
    const placed = (await owner.query(
      'select * from public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', asset.id, 'materials'],
    )).rows[0];
    assert.equal(placed.section_id, 'materials');
    assert.deepEqual((await owner.query(`select section_id
      from public.project_asset_section_placements where asset_id=$1`, [asset.id])).rows,
    [{ section_id: 'materials' }]);

    await assert.rejects(owner.query(`update public.project_resources set section_id=null
      where id=$1`, [asset.id]), /maintained by placement operations/i);
    assert.equal((await owner.query('select section_id from public.project_resources where id=$1',
      [asset.id])).rows[0].section_id, 'materials');

    const unplaced = (await owner.query(
      'select * from public.remove_project_asset_from_section($1,$2,$3)',
      ['aqal', asset.id, 'materials'],
    )).rows[0];
    assert.equal(unplaced.section_id, null);
    assert.equal(unplaced.id, asset.id);
    assert.equal(unplaced.storage_path, storagePath);
    assert.equal((await owner.query(`select count(*) count
      from public.project_asset_section_placements where asset_id=$1`, [asset.id])).rows[0].count, '0');
    assert.equal((await owner.query(`select count(*) count from storage.objects where name=$1`,
      [storagePath])).rows[0].count, '1');
  } finally { await owner.end(); }
});

test('read-only invariant verification detects compatibility drift without repairing it', async () => {
  const asset = await (async () => {
    const owner = await client(OWNER_A);
    try { return await createFinalized(owner, 'verification-drift'); } finally { await owner.end(); }
  })();
  await admin.query('begin');
  try {
    await admin.query('alter table public.project_resources disable trigger project_resources_validate_asset_relationships');
    await admin.query('alter table public.project_resources disable trigger project_resources_sync_asset_section_placement');
    await admin.query('update public.project_resources set section_id=null where id=$1', [asset.id]);
    await admin.query('savepoint before_verification');
    await assert.rejects(
      admin.query('select private.backfill_project_asset_section_placements()'),
      /compatibility designation does not match/i,
    );
    await admin.query('rollback to savepoint before_verification');
    assert.equal((await admin.query(`select count(*) count
      from public.project_asset_section_placements where asset_id=$1`, [asset.id])).rows[0].count, '1');
  } finally {
    await admin.query('rollback');
  }
});

test('direct compatibility updates cannot Move while the Stage 2B Replace RPC remains atomic', async () => {
  const owner = await client(OWNER_A);
  try {
    const id = 'asset-existing-current';
    const storageBefore = (await owner.query(`select storage_path from public.project_resources
      where id=$1`, [id])).rows[0].storage_path;
    const objectCountBefore = Number((await owner.query(`select count(*) count from storage.objects
      where name=$1`, [storageBefore])).rows[0].count);

    await assert.rejects(
      owner.query("update public.project_resources set section_id='notes',updated_at=now() where id=$1", [id]),
      /maintained by placement operations/i,
    );
    assert.equal((await owner.query('select section_id from public.project_resources where id=$1',
      [id])).rows[0].section_id, 'materials');
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1`, [id])).rows, [{ section_id: 'materials' }]);

    await owner.query('select public.replace_project_asset_section($1,$2,$3,$4)',
      ['aqal', id, 'materials', 'notes']);
    assert.equal((await owner.query('select section_id from public.project_resources where id=$1', [id])).rows[0].section_id, 'notes');
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1`, [id])).rows, [{ section_id: 'notes' }]);

    await assert.rejects(owner.query('select public.replace_project_asset_section($1,$2,$3,$4)',
      ['aqal', id, 'notes', 'other-a-section']), /not active/i);
    assert.equal((await owner.query('select section_id from public.project_resources where id=$1', [id])).rows[0].section_id, 'notes');
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1`, [id])).rows, [{ section_id: 'notes' }]);
    assert.equal((await owner.query('select storage_path from public.project_resources where id=$1', [id])).rows[0].storage_path, storageBefore);
    assert.equal(Number((await owner.query(`select count(*) count from storage.objects
      where name=$1`, [storageBefore])).rows[0].count), objectCountBefore);
  } finally {
    await owner.end();
  }
});

test('asset and section archive or restore never delete or recreate placement', async () => {
  const owner = await client(OWNER_A);
  try {
    const assetId = 'asset-existing-archived-section';
    const original = (await owner.query(`select * from public.project_asset_section_placements
      where asset_id=$1`, [assetId])).rows;
    assert.equal((await owner.query("select status from public.project_sections where id='archive-later'")).rows[0].status, 'archived');
    assert.equal((await owner.query("select status from public.project_resources where id=$1", [assetId])).rows[0].status, 'current');

    await owner.query("update public.project_resources set status='archived',updated_at=now() where id=$1", [assetId]);
    await owner.query("update public.project_resources set status='current',updated_at=now() where id=$1", [assetId]);
    await owner.query("update public.project_sections set status='active',updated_at=now() where id='archive-later'");
    await owner.query("update public.project_sections set status='archived',updated_at=now() where id='archive-later'");
    assert.deepEqual((await owner.query(`select * from public.project_asset_section_placements
      where asset_id=$1`, [assetId])).rows, original);

    assert.equal((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id='asset-existing-archived'`)).rows[0].section_id, 'materials');
    assert.equal((await owner.query("select status from public.project_resources where id='asset-existing-archived'")).rows[0].status, 'archived');
  } finally {
    await owner.end();
  }
});

test('composite constraints and resource-kind validation reject forged placements', async () => {
  await assert.rejects(admin.query(`update public.project_asset_section_placements
    set section_id='other-a-section' where owner_id=$1 and project_id='aqal'
      and asset_id='asset-existing-archived'`, [OWNER_A]), /foreign key|active section/i);
  await assert.rejects(admin.query(`update public.project_asset_section_placements
    set owner_id=$1,project_id='other-b',section_id='other-b-section'
    where owner_id=$2 and project_id='aqal' and asset_id='asset-existing-archived'`,
  [OWNER_B, OWNER_A]), /uploaded asset|foreign key/i);
  await assert.rejects(admin.query(`insert into public.project_asset_section_placements(
    owner_id,project_id,asset_id,section_id) values ($1,'aqal','legacy-link','materials')`,
  [OWNER_A]), /uploaded asset/i);
  assert.deepEqual((await admin.query(`select owner_id,project_id,section_id
    from public.project_asset_section_placements
    where asset_id='asset-existing-archived'`)).rows, [{
    owner_id: OWNER_A, project_id: 'aqal', section_id: 'materials',
  }]);
});

test('placement RLS rejects unauthorized visibility and Project filters do not cross scope', async () => {
  const owner = await client(OWNER_A);
  const otherOwner = await client(OWNER_B);
  try {
    assert.equal((await owner.query(`select asset_id from public.project_asset_section_placements
      where project_id='other-a'`)).rowCount, 0);
    assert.equal((await otherOwner.query(`select asset_id from public.project_asset_section_placements
      where owner_id=$1`, [OWNER_A])).rowCount, 0);
    assert.equal((await otherOwner.query(`select asset_id from public.project_asset_section_placements
      where project_id='aqal'`)).rowCount, 0);
  } finally {
    await owner.end();
    await otherOwner.end();
  }
});

test('Stage 2B Add supports two and three memberships without changing asset or Storage identity', async () => {
  const owner = await client(OWNER_A);
  try {
    const asset = await createFinalized(owner, 'multi-add');
    const before = (await owner.query(`select id,section_id,storage_path from public.project_resources
      where id=$1`, [asset.id])).rows[0];
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)', ['aqal', asset.id, 'notes']);
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)', ['aqal', asset.id, 'fallback-a']);
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)', ['aqal', asset.id, 'notes']);
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1 order by section_id`, [asset.id])).rows, [
      { section_id: 'fallback-a' }, { section_id: 'materials' }, { section_id: 'notes' },
    ]);
    assert.deepEqual((await owner.query(`select id,section_id,storage_path from public.project_resources
      where id=$1`, [asset.id])).rows[0], before);
    assert.equal((await owner.query(`select count(*) count from storage.objects
      where name=$1`, [before.storage_path])).rows[0].count, '1');
  } finally { await owner.end(); }
});

test('Stage 2B metadata PATCHes with the current designation preserve every placement', async () => {
  const owner = await client(OWNER_A);
  try {
    const asset = await createFinalized(owner, 'stage-2b-current-metadata');
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)', ['aqal', asset.id, 'fallback-a']);
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)', ['aqal', asset.id, 'fallback-b']);
    const expectedPlacements = [
      { section_id: 'fallback-a' }, { section_id: 'fallback-b' }, { section_id: 'materials' },
    ];
    const patch = async (name, status) => owner.query(`update public.project_resources
      set description=$2,name=$3,section_id=$4,status=$5,updated_at=now() where id=$1`,
    [asset.id, 'Stage 2B metadata', name, 'materials', status]);

    await patch('Renamed', 'current');
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1 order by section_id`, [asset.id])).rows, expectedPlacements);
    await patch('Renamed', 'archived');
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1 order by section_id`, [asset.id])).rows, expectedPlacements);
    await patch('Renamed', 'current');
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1 order by section_id`, [asset.id])).rows, expectedPlacements);
    assert.deepEqual((await owner.query(`select name,status,section_id from public.project_resources
      where id=$1`, [asset.id])).rows[0],
    { name: 'Renamed', section_id: 'materials', status: 'current' });
  } finally { await owner.end(); }
});

test('stale Stage 2B rename, archive, and restore cannot resurrect a final placement', async () => {
  const owner = await client(OWNER_A);
  try {
    for (const operation of ['rename', 'archive', 'restore']) {
      const asset = await createFinalized(owner, `stale-final-${operation}`);
      if (operation === 'restore') {
        await owner.query(`update public.project_resources set section_id='materials',status='archived'
          where id=$1`, [asset.id]);
      }
      await owner.query('select public.remove_project_asset_from_section($1,$2,$3)',
        ['aqal', asset.id, 'materials']);
      const status = operation === 'archive' ? 'archived' : 'current';
      const name = operation === 'rename' ? 'Stale rename' : asset.name;
      await assert.rejects(owner.query(`update public.project_resources
        set description=null,name=$2,section_id='materials',status=$3,updated_at=now()
        where id=$1`, [asset.id, name, status]), /maintained by placement operations/i);
      assert.equal((await owner.query(`select count(*) count
        from public.project_asset_section_placements where asset_id=$1`, [asset.id])).rows[0].count, '0');
      const resource = (await owner.query(`select name,status,section_id from public.project_resources
        where id=$1`, [asset.id])).rows[0];
      assert.equal(resource.section_id, null);
      assert.equal(resource.status, operation === 'restore' ? 'archived' : 'current');
      if (operation === 'rename') assert.notEqual(resource.name, 'Stale rename');
    }
  } finally { await owner.end(); }
});

test('stale Stage 2B metadata cannot replace a newer designation whether the old placement is absent or retained', async () => {
  const owner = await client(OWNER_A);
  try {
    const removedOld = await createFinalized(owner, 'stale-designation-removed');
    await owner.query('select public.replace_project_asset_section($1,$2,$3,$4)',
      ['aqal', removedOld.id, 'materials', 'notes']);
    await assert.rejects(owner.query(`update public.project_resources
      set description=null,name='Stale',section_id='materials',status='current',updated_at=now()
      where id=$1`, [removedOld.id]), /maintained by placement operations/i);
    assert.equal((await owner.query('select section_id from public.project_resources where id=$1',
      [removedOld.id])).rows[0].section_id, 'notes');
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1`, [removedOld.id])).rows, [{ section_id: 'notes' }]);

    const retainedOld = await createFinalized(owner, 'stale-designation-retained');
    await owner.query('select public.replace_project_asset_section($1,$2,$3,$4)',
      ['aqal', retainedOld.id, 'materials', 'notes']);
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', retainedOld.id, 'materials']);
    await assert.rejects(owner.query(`update public.project_resources
      set description=null,name='Stale',section_id='materials',status='current',updated_at=now()
      where id=$1`, [retainedOld.id]), /maintained by placement operations/i);
    assert.equal((await owner.query('select section_id from public.project_resources where id=$1',
      [retainedOld.id])).rows[0].section_id, 'notes');
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1 order by section_id`, [retainedOld.id])).rows,
    [{ section_id: 'materials' }, { section_id: 'notes' }]);
  } finally { await owner.end(); }
});

test('Remove preserves unrelated memberships, uses exact fallback, and permits a final removal', async () => {
  const owner = await client(OWNER_A);
  try {
    const asset = await createFinalized(owner, 'remove-fallback');
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)', ['aqal', asset.id, 'notes']);
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)', ['aqal', asset.id, 'fallback-b']);
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)', ['aqal', asset.id, 'fallback-a']);
    await admin.query(`update public.project_asset_section_placements set created_at='2026-09-01T00:00:00Z'
      where asset_id=$1 and section_id in ('fallback-a','fallback-b')`, [asset.id]);
    await owner.query('select public.remove_project_asset_from_section($1,$2,$3)', ['aqal', asset.id, 'notes']);
    await owner.query('select public.remove_project_asset_from_section($1,$2,$3)', ['aqal', asset.id, 'materials']);
    assert.equal((await owner.query('select section_id from public.project_resources where id=$1',
      [asset.id])).rows[0].section_id, 'fallback-a');
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1 order by section_id`, [asset.id])).rows,
    [{ section_id: 'fallback-a' }, { section_id: 'fallback-b' }]);
    await owner.query('select public.remove_project_asset_from_section($1,$2,$3)', ['aqal', asset.id, 'fallback-b']);
    await owner.query('select public.remove_project_asset_from_section($1,$2,$3)',
      ['aqal', asset.id, 'fallback-a']);
    assert.equal((await owner.query('select section_id from public.project_resources where id=$1',
      [asset.id])).rows[0].section_id, null);
    assert.equal((await owner.query(`select count(*) count from public.project_asset_section_placements
      where asset_id=$1`, [asset.id])).rows[0].count, '0');
    assert.equal((await owner.query('select count(*) count from public.project_resources where id=$1',
      [asset.id])).rows[0].count, '1');
    assert.equal((await owner.query('select count(*) count from storage.objects where name=$1',
      [asset.storage_path])).rows[0].count, '1');
  } finally { await owner.end(); }
});

test('designated removal prefers active compatibility fallbacks and retains archived relationships', async () => {
  const owner = await client(OWNER_A);
  try {
    await owner.query(`insert into public.project_sections(
      owner_id,id,created_at,is_default,position,project_id,status,title,updated_at
    ) values
      ($1,'archived-fallback','${AT}',false,20,'aqal','active','Archived fallback','${AT}'),
      ($1,'active-fallback','${AT}',false,21,'aqal','active','Active fallback','${AT}'),
      ($1,'archived-only','${AT}',false,22,'aqal','active','Archived only','${AT}')`, [OWNER_A]);
    const asset = await createFinalized(owner, 'active-fallback-selection');
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', asset.id, 'archived-fallback']);
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', asset.id, 'active-fallback']);
    await admin.query(`update public.project_asset_section_placements
      set created_at = case section_id
        when 'archived-fallback' then '2026-08-01T00:00:00Z'::timestamptz
        else '2026-08-02T00:00:00Z'::timestamptz end
      where asset_id=$1 and section_id in ('archived-fallback','active-fallback')`, [asset.id]);
    await owner.query("update public.project_sections set status='archived' where id='archived-fallback'");
    await owner.query('select public.remove_project_asset_from_section($1,$2,$3)',
      ['aqal', asset.id, 'materials']);
    assert.equal((await owner.query('select section_id from public.project_resources where id=$1',
      [asset.id])).rows[0].section_id, 'active-fallback');
    await owner.query('select public.replace_project_asset_section($1,$2,$3,$4)',
      ['aqal', asset.id, 'active-fallback', 'notes']);
    assert.equal((await owner.query('select section_id from public.project_resources where id=$1',
      [asset.id])).rows[0].section_id, 'notes');
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1 order by section_id`, [asset.id])).rows,
    [{ section_id: 'archived-fallback' }, { section_id: 'notes' }]);

    const archivedOnly = await createFinalized(owner, 'archived-only-selection');
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', archivedOnly.id, 'archived-only']);
    await owner.query("update public.project_sections set status='archived' where id='archived-only'");
    await owner.query('select public.remove_project_asset_from_section($1,$2,$3)',
      ['aqal', archivedOnly.id, 'materials']);
    assert.equal((await owner.query('select section_id from public.project_resources where id=$1',
      [archivedOnly.id])).rows[0].section_id, 'archived-only');

    await owner.query("update public.project_sections set status='active' where id in ('archived-fallback','archived-only')");
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1 order by section_id`, [asset.id])).rows,
    [{ section_id: 'archived-fallback' }, { section_id: 'notes' }]);
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1`, [archivedOnly.id])).rows, [{ section_id: 'archived-only' }]);
  } finally { await owner.end(); }
});

test('Replace is atomic, retains unrelated placements, and safely consumes an existing target', async () => {
  const owner = await client(OWNER_A);
  try {
    const asset = await createFinalized(owner, 'replace-multi');
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)', ['aqal', asset.id, 'notes']);
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)', ['aqal', asset.id, 'fallback-a']);
    await owner.query('select public.replace_project_asset_section($1,$2,$3,$4)',
      ['aqal', asset.id, 'notes', 'fallback-a']);
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1 order by section_id`, [asset.id])).rows,
    [{ section_id: 'fallback-a' }, { section_id: 'materials' }]);
    await assert.rejects(owner.query('select public.replace_project_asset_section($1,$2,$3,$4)',
      ['aqal', asset.id, 'materials', 'archive-later']), /not active/i);
    assert.equal((await owner.query('select section_id from public.project_resources where id=$1',
      [asset.id])).rows[0].section_id, 'materials');
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1 order by section_id`, [asset.id])).rows,
    [{ section_id: 'fallback-a' }, { section_id: 'materials' }]);
  } finally { await owner.end(); }
});

test('controlled placement mutations enforce owner, Project, resource-kind, and active-target boundaries', async () => {
  const owner = await client(OWNER_A);
  const otherOwner = await client(OWNER_B);
  try {
    await assert.rejects(owner.query('select public.add_project_asset_to_section($1,$2,$3)',
      ['other-a', 'asset-existing-current', 'other-a-section']), /not found/i);
    await assert.rejects(owner.query('select public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', 'legacy-link', 'notes']), /not found/i);
    await assert.rejects(owner.query('select public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', 'asset-existing-current', 'archive-later']), /not active/i);
    await assert.rejects(otherOwner.query('select public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', 'asset-existing-current', 'notes']), /not found/i);
  } finally { await owner.end(); await otherOwner.end(); }
});

test('section archive and Add serialize in both commit orders', async () => {
  const placement = await client(OWNER_A);
  const archive = await client(OWNER_A);
  try {
    const first = await createFinalized(placement, 'concurrent-add-archive-first');
    await archive.query('begin');
    await archive.query("update public.project_sections set status='archived' where id='notes'");
    const rejectedAdd = placement.query('select public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', first.id, 'notes']);
    await assertStillPending(rejectedAdd, 'Add after archive');
    await archive.query('commit');
    await assert.rejects(rejectedAdd, /not active/i);
    assert.equal((await placement.query(`select 1 from public.project_asset_section_placements
      where asset_id=$1 and section_id='notes'`, [first.id])).rowCount, 0);

    await archive.query("update public.project_sections set status='active' where id='notes'");
    const second = await createFinalized(placement, 'concurrent-add-placement-first');
    await placement.query('begin');
    await placement.query('select public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', second.id, 'notes']);
    const waitingArchive = archive.query(
      "update public.project_sections set status='archived' where id='notes'");
    await assertStillPending(waitingArchive, 'Archive after Add');
    await placement.query('commit');
    await waitingArchive;
    assert.equal((await placement.query(`select 1 from public.project_asset_section_placements
      where asset_id=$1 and section_id='notes'`, [second.id])).rowCount, 1);
  } finally {
    await placement.query('rollback').catch(() => undefined);
    await archive.query('rollback').catch(() => undefined);
    await archive.query("update public.project_sections set status='active' where id='notes'").catch(() => undefined);
    await placement.end(); await archive.end();
  }
});

test('archive-first rejects Replace and direct compatibility updates cannot bypass placement RPCs', async () => {
  const placement = await client(OWNER_A);
  const archive = await client(OWNER_A);
  try {
    for (const [kind, id] of [['replace', 'concurrent-replace'], ['legacy', 'concurrent-legacy']]) {
      const asset = await createFinalized(placement, id);
      await archive.query('begin');
      await archive.query("update public.project_sections set status='archived' where id='fallback-b'");
      const operation = kind === 'replace'
        ? placement.query('select public.replace_project_asset_section($1,$2,$3,$4)',
          ['aqal', asset.id, 'materials', 'fallback-b'])
        : placement.query("update public.project_resources set section_id='fallback-b' where id=$1",
          [asset.id]);
      if (kind === 'replace') {
        await assertStillPending(operation, `${kind} after archive`);
        await archive.query('commit');
        await assert.rejects(operation, /not active|active section/i);
      } else {
        await assert.rejects(operation, /maintained by placement operations/i);
        await archive.query('commit');
      }
      assert.equal((await placement.query('select section_id from public.project_resources where id=$1',
        [asset.id])).rows[0].section_id, 'materials');
      assert.deepEqual((await placement.query(`select section_id
        from public.project_asset_section_placements where asset_id=$1`, [asset.id])).rows,
      [{ section_id: 'materials' }]);
      await archive.query("update public.project_sections set status='active' where id='fallback-b'");
    }
  } finally {
    await placement.query('rollback').catch(() => undefined);
    await archive.query('rollback').catch(() => undefined);
    await archive.query("update public.project_sections set status='active' where id='fallback-b'").catch(() => undefined);
    await placement.end(); await archive.end();
  }
});

test('initial finalization and reconciliation serialize with section archive', async () => {
  const placement = await client(OWNER_A);
  const archive = await client(OWNER_A);
  try {
    const rejected = await reserve(placement, 'concurrent-finalize-archive-first', { sectionId: 'notes' });
    await store(placement, rejected.storage_path);
    await archive.query('begin');
    await archive.query("update public.project_sections set status='archived' where id='notes'");
    const rejectedFinalize = finalize(placement, rejected.attempt_id);
    await assertStillPending(rejectedFinalize, 'Finalize after archive');
    await archive.query('commit');
    await assert.rejects(rejectedFinalize, /active section/i);
    assert.equal((await placement.query('select 1 from public.project_resources where id=$1',
      [rejected.asset_id])).rowCount, 0);

    await archive.query("update public.project_sections set status='active' where id='notes'");
    const reconciled = await reserve(placement, 'concurrent-reconcile-archive-first', { sectionId: 'notes' });
    await store(placement, reconciled.storage_path);
    await archive.query('begin');
    await archive.query("update public.project_sections set status='archived' where id='notes'");
    const rejectedReconcile = placement.query('select public.reconcile_project_asset_uploads($1,$2)',
      ['aqal', 'notes']);
    await assertStillPending(rejectedReconcile, 'Reconciliation after archive');
    await archive.query('commit');
    await assert.rejects(rejectedReconcile, /active section/i);
    assert.equal((await placement.query('select 1 from public.project_resources where id=$1',
      [reconciled.asset_id])).rowCount, 0);

    await archive.query("update public.project_sections set status='active' where id='notes'");
    const accepted = await reserve(placement, 'concurrent-finalize-placement-first', { sectionId: 'notes' });
    await store(placement, accepted.storage_path);
    await placement.query('begin');
    await finalize(placement, accepted.attempt_id);
    const waitingArchive = archive.query(
      "update public.project_sections set status='archived' where id='notes'");
    await assertStillPending(waitingArchive, 'Archive after finalization');
    await placement.query('commit');
    await waitingArchive;
    assert.equal((await placement.query(`select 1 from public.project_asset_section_placements
      where asset_id=$1 and section_id='notes'`, [accepted.asset_id])).rowCount, 1);
    assert.equal((await finalize(placement, accepted.attempt_id)).id, accepted.asset_id);
    assert.equal((await placement.query(`select count(*) count
      from public.project_asset_section_placements where asset_id=$1`,
    [accepted.asset_id])).rows[0].count, '1');
  } finally {
    await placement.query('rollback').catch(() => undefined);
    await archive.query('rollback').catch(() => undefined);
    await archive.query("update public.project_sections set status='active' where id='notes'").catch(() => undefined);
    await placement.end(); await archive.end();
  }
});

test('ascending section lock order avoids deadlock for opposing replacements', async () => {
  const firstConnection = await client(OWNER_A);
  const secondConnection = await client(OWNER_A);
  try {
    const first = await createFinalized(firstConnection, 'lock-order-first');
    await firstConnection.query('select public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', first.id, 'notes']);
    const second = await createFinalized(secondConnection, 'lock-order-second',
      { sectionId: 'fallback-a' });
    await firstConnection.query('begin');
    await secondConnection.query('begin');
    await firstConnection.query('select public.replace_project_asset_section($1,$2,$3,$4)',
      ['aqal', first.id, 'notes', 'fallback-a']);
    const opposing = secondConnection.query(
      'select public.replace_project_asset_section($1,$2,$3,$4)',
      ['aqal', second.id, 'fallback-a', 'notes']);
    await assertStillPending(opposing, 'Opposing replacement');
    await firstConnection.query('commit');
    await opposing;
    await secondConnection.query('commit');
  } finally {
    await firstConnection.query('rollback').catch(() => undefined);
    await secondConnection.query('rollback').catch(() => undefined);
    await firstConnection.end(); await secondConnection.end();
  }
});

test('concurrent final Remove and first Add serialize to one valid surviving placement', async () => {
  const firstConnection = await client(OWNER_A);
  const secondConnection = await client(OWNER_A);
  try {
    const removeFirst = await createFinalized(firstConnection, 'concurrent-remove-first');
    await firstConnection.query('begin');
    await secondConnection.query('begin');
    await firstConnection.query('select public.remove_project_asset_from_section($1,$2,$3)',
      ['aqal', removeFirst.id, 'materials']);
    const waitingAdd = secondConnection.query(
      'select public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', removeFirst.id, 'notes']);
    await assertStillPending(waitingAdd, 'Add after final Remove');
    await firstConnection.query('commit');
    await waitingAdd;
    await secondConnection.query('commit');
    assert.equal((await admin.query('select section_id from public.project_resources where id=$1',
      [removeFirst.id])).rows[0].section_id, 'notes');
    assert.deepEqual((await admin.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1`, [removeFirst.id])).rows, [{ section_id: 'notes' }]);

    const addFirst = await createFinalized(firstConnection, 'concurrent-add-first');
    await firstConnection.query('begin');
    await secondConnection.query('begin');
    await firstConnection.query('select public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', addFirst.id, 'notes']);
    const waitingRemove = secondConnection.query(
      'select public.remove_project_asset_from_section($1,$2,$3)',
      ['aqal', addFirst.id, 'materials']);
    await assertStillPending(waitingRemove, 'final Remove after Add');
    await firstConnection.query('commit');
    await waitingRemove;
    await secondConnection.query('commit');
    assert.equal((await admin.query('select section_id from public.project_resources where id=$1',
      [addFirst.id])).rows[0].section_id, 'notes');
    assert.deepEqual((await admin.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1`, [addFirst.id])).rows, [{ section_id: 'notes' }]);
  } finally {
    await firstConnection.query('rollback').catch(() => undefined);
    await secondConnection.query('rollback').catch(() => undefined);
    await firstConnection.end(); await secondConnection.end();
  }
});

test('placement operations touch recency once, failures never touch, and recency failure is secondary', async () => {
  await admin.query(`
    create table public.project_recency_audit(project_id text not null);
    create function public.audit_project_recency() returns trigger language plpgsql as $$
    begin insert into public.project_recency_audit values (new.id); return new; end $$;
    create trigger audit_project_recency after update on public.projects
      for each row execute function public.audit_project_recency();
  `);
  const owner = await client(OWNER_A);
  try {
    const asset = await createFinalized(owner, 'recency');
    await admin.query('truncate public.project_recency_audit');
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)', ['aqal', asset.id, 'notes']);
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)', ['aqal', asset.id, 'notes']);
    assert.equal((await admin.query('select * from public.project_recency_audit')).rowCount, 1);
    await admin.query('truncate public.project_recency_audit');
    await owner.query('select public.remove_project_asset_from_section($1,$2,$3)', ['aqal', asset.id, 'notes']);
    assert.equal((await admin.query('select * from public.project_recency_audit')).rowCount, 1);
    await admin.query('truncate public.project_recency_audit');
    await owner.query('select public.replace_project_asset_section($1,$2,$3,$4)',
      ['aqal', asset.id, 'materials', 'notes']);
    assert.equal((await admin.query('select * from public.project_recency_audit')).rowCount, 1);
    await admin.query('truncate public.project_recency_audit');
    await owner.query('select public.remove_project_asset_from_section($1,$2,$3)',
      ['aqal', asset.id, 'notes']);
    assert.equal((await admin.query('select * from public.project_recency_audit')).rowCount, 1);

    await admin.query(`create function public.fail_project_recency() returns trigger language plpgsql as $$
      begin raise exception 'recency unavailable'; end $$;
      create trigger fail_project_recency before update on public.projects
        for each row execute function public.fail_project_recency()`);
    await owner.query('select public.add_project_asset_to_section($1,$2,$3)',
      ['aqal', asset.id, 'fallback-a']);
    assert.deepEqual((await owner.query(`select section_id from public.project_asset_section_placements
      where asset_id=$1 order by section_id`, [asset.id])).rows,
    [{ section_id: 'fallback-a' }]);
    await admin.query('drop trigger fail_project_recency on public.projects');
    await admin.query('drop function public.fail_project_recency()');
  } finally { await owner.end(); }
});

test('migration leaves Storage identity and authorization definitions placement-independent', async () => {
  const migration = await readFile(path.join(ROOT, 'supabase', 'migrations', PLACEMENT_MIGRATION), 'utf8');
  assert.doesNotMatch(migration, /storage\.objects|storage\.buckets|project_assets_exact_select|signed_url/i);
  assert.doesNotMatch(migration, /object_id|storage_path/);
  assert.match(migration, /project_resources_sync_asset_section_placement/);
  assert.match(migration, /after insert or update on public\.project_resources/);
  const stage2b = await readFile(path.join(ROOT, 'supabase', 'migrations', MULTI_PLACEMENT_MIGRATION), 'utf8');
  assert.doesNotMatch(stage2b, /storage\.objects|storage\.buckets|signed_url|object_id/i);
  assert.doesNotMatch(stage2b, /(?:insert|update|delete)[\s\S]{0,80}storage_path/i);
  const stage2c = await readFile(path.join(ROOT, 'supabase', 'migrations', GLOBAL_ASSET_MIGRATION), 'utf8');
  assert.doesNotMatch(stage2c, /(?:insert|update|delete)[\s\S]{0,80}storage_path/i);
  assert.doesNotMatch(stage2c, /create policy|alter table storage\./i);
});
