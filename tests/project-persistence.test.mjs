import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ProjectService } from '../src/services/projects/project-service.ts';
import { ProjectAssetFinalPlacementError } from '../src/services/projects/project-repository.ts';
import { SupabaseProjectRepository } from '../src/services/projects/supabase-project-repository.ts';

const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';
const PROJECT_ID = 'project-1';
const CREATED_AT = '2026-08-13T12:00:00.000Z';
const OPERATION_AT = '2026-08-13T13:00:00.000Z';

const CHANGE_TABLES = {
  change_events: 'project_change_events',
  decisions: 'project_decisions',
  deliverables: 'project_deliverables',
  knowledge_items: 'project_knowledge_items',
  milestones: 'project_milestones',
  projects: 'projects',
  resources: 'project_resources',
  sections: 'project_sections',
  tasks: 'project_tasks',
  work_session_entries: 'project_work_session_entries',
  work_sessions: 'project_work_sessions',
};

function clone(value) {
  return structuredClone(value);
}

class FakeQuery {
  constructor(database, ownerId, table) {
    this.database = database;
    this.ownerId = ownerId;
    this.table = table;
    this.filters = [];
    this.orders = [];
    this.operation = 'select';
  }

  select() { return this; }
  eq(column, value) { this.filters.push([column, value]); return this; }
  order(column) { this.orders.push(column); return this; }
  maybeSingle() { this.single = true; return this; }
  upsert(row) { this.operation = 'upsert'; this.row = row; return this; }

  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }

  execute() {
    const table = this.database.table(this.table);
    if (this.operation === 'upsert') {
      const ownedRow = { ...clone(this.row), owner_id: this.ownerId };
      table.set(`${this.ownerId}:${ownedRow.id}`, ownedRow);
      return { data: null, error: null };
    }

    const rows = [...table.values()]
      .filter((row) => row.owner_id === this.ownerId)
      .filter((row) => this.filters.every(([column, value]) => row[column] === value))
      .sort((left, right) => {
        for (const column of this.orders) {
          const comparison = String(left[column]).localeCompare(String(right[column]));
          if (comparison) return comparison;
        }
        return 0;
      })
      .map(clone);
    return this.single
      ? { data: rows[0] ?? null, error: null }
      : { data: rows, error: null };
  }
}

class FakeSupabaseDatabase {
  constructor() {
    this.tables = new Map();
    this.commitCalls = 0;
    this.failNextCommit = false;
  }

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name);
  }

  client(ownerId) {
    return {
      from: (table) => new FakeQuery(this, ownerId, table),
      rpc: async (name, input) => {
        if (name === 'reorder_project_sections') {
          const table = this.table('project_sections');
          const rows = input.p_section_ids.map((id, position) => {
            const key = `${ownerId}:${id}`;
            const row = table.get(key);
            if (!row || row.project_id !== input.p_project_id || row.status !== 'active') {
              return null;
            }
            const updated = { ...row, position, updated_at: input.p_updated_at };
            table.set(key, updated);
            return clone(updated);
          });
          return rows.some((row) => !row)
            ? { data: null, error: new Error('Cross-Project reorder rejected') }
            : { data: rows, error: null };
        }
        assert.equal(name, 'commit_project_changes');
        const changes = input.p_changes;
        this.commitCalls += 1;
        if (this.failNextCommit) {
          this.failNextCommit = false;
          return { data: null, error: new Error('Injected transaction failure') };
        }
        const nextTables = structuredClone(this.tables);
        for (const [changeName, rows] of Object.entries(changes)) {
          const tableName = CHANGE_TABLES[changeName];
          if (!nextTables.has(tableName)) nextTables.set(tableName, new Map());
          const table = nextTables.get(tableName);
          for (const row of rows) {
            const ownedRow = { ...clone(row), owner_id: ownerId };
            table.set(`${ownerId}:${ownedRow.id}`, ownedRow);
          }
        }
        this.tables = nextTables;
        return { data: null, error: null };
      },
    };
  }
}

function project() {
  return {
    createdAt: CREATED_AT,
    description: 'Persistence test',
    id: PROJECT_ID,
    name: 'Persisted project',
    priority: 'high',
    status: 'active',
    timezone: 'America/Toronto',
    type: 'general',
    updatedAt: CREATED_AT,
  };
}

function repository(database, ownerId = OWNER_A) {
  const client = database.client(ownerId);
  return new SupabaseProjectRepository(() => client);
}

test('projects and every existing child shape survive a fresh repository session', async () => {
  const database = new FakeSupabaseDatabase();
  const first = repository(database);
  await first.saveProject(project());
  await first.saveMilestone({ createdAt: CREATED_AT, id: 'milestone-1', name: 'First', position: 1, projectId: PROJECT_ID, status: 'active', updatedAt: CREATED_AT });
  await first.saveDeliverable({ createdAt: CREATED_AT, id: 'deliverable-1', milestoneId: 'milestone-1', name: 'Draft', position: 1, projectId: PROJECT_ID, status: 'in_progress', updatedAt: CREATED_AT });
  await first.saveWorkSession({ createdAt: CREATED_AT, id: 'session-1', projectId: PROJECT_ID, startedAt: CREATED_AT, title: 'Raw notes', updatedAt: CREATED_AT });
  await first.saveTask({ createdAt: CREATED_AT, deliverableId: 'deliverable-1', id: 'task-1', milestoneId: 'milestone-1', position: 1, priority: 'normal', projectId: PROJECT_ID, sourceSessionId: 'session-1', status: 'in_progress', title: 'Write', updatedAt: CREATED_AT });
  await first.saveKnowledgeItem({ content: 'A durable fact', createdAt: CREATED_AT, id: 'knowledge-1', kind: 'fact', projectId: PROJECT_ID, sourceSessionId: 'session-1', status: 'current', updatedAt: CREATED_AT });
  await first.saveDecision({ createdAt: CREATED_AT, decidedAt: CREATED_AT, id: 'decision-1', projectId: PROJECT_ID, sourceSessionId: 'session-1', statement: 'Keep the model', status: 'active', updatedAt: CREATED_AT });
  await first.saveResource({ createdAt: CREATED_AT, externalUrl: 'https://example.com', id: 'resource-1', name: 'Reference', projectId: PROJECT_ID, role: 'reference', sourceSessionId: 'session-1', type: 'link', updatedAt: CREATED_AT });
  await first.saveSection({ createdAt: CREATED_AT, id: 'section-1', isDefault: true, position: 0, projectId: PROJECT_ID, status: 'active', title: 'Overview', updatedAt: CREATED_AT });
  await first.saveWorkSessionEntry({ content: 'Unmodified raw thought', id: 'entry-1', kind: 'user_message', occurredAt: CREATED_AT, position: 1, sessionId: 'session-1' });

  const fresh = repository(database);
  assert.deepEqual(await fresh.getProject(PROJECT_ID), project());
  assert.equal((await fresh.getMilestone('milestone-1')).name, 'First');
  assert.equal((await fresh.getDeliverable('deliverable-1')).name, 'Draft');
  assert.equal((await fresh.listMilestones(PROJECT_ID))[0].id, 'milestone-1');
  assert.equal((await fresh.listDeliverables(PROJECT_ID))[0].milestoneId, 'milestone-1');
  assert.equal((await fresh.listTasks(PROJECT_ID))[0].sourceSessionId, 'session-1');
  assert.equal((await fresh.listKnowledgeItems(PROJECT_ID))[0].content, 'A durable fact');
  assert.equal((await fresh.listDecisions(PROJECT_ID))[0].statement, 'Keep the model');
  assert.equal((await fresh.listResources(PROJECT_ID))[0].externalUrl, 'https://example.com');
  assert.equal((await fresh.listSections(PROJECT_ID))[0].title, 'Overview');
  assert.deepEqual(await fresh.listWorkSessionEntries('session-1'), [{ content: 'Unmodified raw thought', id: 'entry-1', kind: 'user_message', occurredAt: CREATED_AT, position: 1, sessionId: 'session-1' }]);
});

test('repository reads are isolated to the authenticated owner', async () => {
  const database = new FakeSupabaseDatabase();
  await repository(database, OWNER_A).saveProject(project());
  assert.equal(await repository(database, OWNER_B).getProject(PROJECT_ID), null);
  assert.deepEqual(await repository(database, OWNER_B).listProjects(), []);
  await repository(database, OWNER_A).saveSection({ createdAt: CREATED_AT, id: 'section-1', isDefault: true, position: 0, projectId: PROJECT_ID, status: 'active', title: 'Overview', updatedAt: CREATED_AT });
  assert.equal(await repository(database, OWNER_B).getSection('section-1'), null);
  assert.deepEqual(await repository(database, OWNER_B).listSections(PROJECT_ID), []);
});

test('Supabase placement and Project-global asset reads are owner and Project scoped', async () => {
  const database = new FakeSupabaseDatabase();
  const resourceTable = database.table('project_resources');
  const placementTable = database.table('project_asset_section_placements');
  const uploadedRow = (ownerId, id, projectId, createdAt, status = 'current') => ({
    byte_size: 4, created_at: createdAt, id, mime_type: 'image/png', name: `${id}.png`,
    original_filename: `${id}.png`, owner_id: ownerId, project_id: projectId,
    resource_kind: 'uploaded_asset', role: 'reference', section_id: 'section-1',
    source_metadata: { kind: 'original-upload' }, status,
    storage_path: `${ownerId}/${projectId}/${id}/private-object`, type: 'image',
    updated_at: createdAt,
  });
  resourceTable.set(`${OWNER_A}:asset-b`, uploadedRow(OWNER_A, 'asset-b', PROJECT_ID, OPERATION_AT, 'archived'));
  resourceTable.set(`${OWNER_A}:asset-a`, uploadedRow(OWNER_A, 'asset-a', PROJECT_ID, CREATED_AT));
  resourceTable.set(`${OWNER_A}:legacy`, {
    created_at: CREATED_AT, id: 'legacy', name: 'Legacy', owner_id: OWNER_A,
    project_id: PROJECT_ID, resource_kind: 'legacy', role: 'reference', type: 'link',
    updated_at: CREATED_AT,
  });
  resourceTable.set(`${OWNER_A}:other-project`, uploadedRow(OWNER_A, 'other-project', 'project-2', CREATED_AT));
  resourceTable.set(`${OWNER_B}:other-owner`, uploadedRow(OWNER_B, 'other-owner', PROJECT_ID, CREATED_AT));
  for (const row of [
    { asset_id: 'asset-b', created_at: OPERATION_AT, owner_id: OWNER_A, project_id: PROJECT_ID, section_id: 'section-1' },
    { asset_id: 'asset-a', created_at: CREATED_AT, owner_id: OWNER_A, project_id: PROJECT_ID, section_id: 'section-1' },
    { asset_id: 'other-project', created_at: CREATED_AT, owner_id: OWNER_A, project_id: 'project-2', section_id: 'other-section' },
    { asset_id: 'other-owner', created_at: CREATED_AT, owner_id: OWNER_B, project_id: PROJECT_ID, section_id: 'section-1' },
  ]) placementTable.set(`${row.owner_id}:${row.project_id}:${row.asset_id}`, row);

  const owner = repository(database, OWNER_A);
  assert.deepEqual((await owner.listProjectAssets(PROJECT_ID)).map(({ id, status }) => [id, status]), [
    ['asset-a', 'current'], ['asset-b', 'archived'],
  ]);
  assert.equal('storagePath' in (await owner.listProjectAssets(PROJECT_ID))[0], false);
  assert.deepEqual((await owner.listAssetPlacements(PROJECT_ID, 'asset-a')).map(({ sectionId }) => sectionId), ['section-1']);
  assert.deepEqual((await owner.listSectionAssetPlacements(PROJECT_ID, 'section-1')).map(({ assetId }) => assetId), ['asset-a', 'asset-b']);
  assert.deepEqual(await repository(database, OWNER_B).listProjectAssets('project-2'), []);
  assert.deepEqual(await repository(database, OWNER_B).listSectionAssetPlacements('project-2', 'other-section'), []);
});

test('Supabase removal maps only the final-placement constraint code to a typed condition', async () => {
  const finalPlacement = new SupabaseProjectRepository(() => ({
    rpc: async () => ({ data: null, error: { code: '23514', message: 'database detail' } }),
  }));
  await assert.rejects(
    finalPlacement.removeAssetPlacement(PROJECT_ID, 'asset-a', 'section-1'),
    ProjectAssetFinalPlacementError,
  );

  const unrelated = { code: '42501', message: 'database authorization detail' };
  const unknownFailure = new SupabaseProjectRepository(() => ({
    rpc: async () => ({ data: null, error: unrelated }),
  }));
  await assert.rejects(
    unknownFailure.removeAssetPlacement(PROJECT_ID, 'asset-a', 'section-1'),
    (error) => error === unrelated,
  );
});

test('new Project and Overview use one atomic repository commit', async () => {
  const database = new FakeSupabaseDatabase();
  const projects = repository(database);
  const service = new ProjectService(projects, {
    createId: () => PROJECT_ID,
    now: () => new Date(CREATED_AT),
  });

  database.failNextCommit = true;
  await assert.rejects(
    service.createProject({ name: 'Atomic Project', timezone: 'America/Toronto' }),
    /Injected transaction failure/,
  );
  assert.equal(await projects.getProject(PROJECT_ID), null);
  assert.deepEqual(await projects.listSections(PROJECT_ID), []);

  await service.createProject({ name: 'Atomic Project', timezone: 'America/Toronto' });
  assert.equal((await projects.getProject(PROJECT_ID)).name, 'Atomic Project');
  assert.deepEqual((await projects.listSections(PROJECT_ID)).map(({ title }) => title), ['Overview']);
});

test('meaningful entity and history writes use one atomic RPC and roll back together', async () => {
  const database = new FakeSupabaseDatabase();
  const projects = repository(database);
  await projects.saveProject(project());
  await projects.saveTask({ createdAt: CREATED_AT, id: 'task-1', position: 0, priority: 'normal', projectId: PROJECT_ID, status: 'in_progress', title: 'Finish', updatedAt: CREATED_AT });
  const service = new ProjectService(projects, { createId: () => 'event-1', now: () => new Date(OPERATION_AT) });

  database.failNextCommit = true;
  await assert.rejects(service.completeTask('task-1'), /Injected transaction failure/);
  assert.equal((await projects.getTask('task-1')).status, 'in_progress');
  assert.deepEqual(await projects.listChangeEvents(PROJECT_ID), []);

  await service.completeTask('task-1');
  assert.equal(database.commitCalls, 2);
  assert.equal((await projects.getTask('task-1')).status, 'completed');
  assert.deepEqual((await projects.listChangeEvents(PROJECT_ID)).map((event) => event.eventType), ['task_completed']);
});

test('superseded knowledge and decision replacement links persist', async () => {
  const database = new FakeSupabaseDatabase();
  const projects = repository(database);
  await projects.saveProject(project());
  await projects.saveKnowledgeItem({ content: 'Old fact', createdAt: CREATED_AT, id: 'knowledge-1', kind: 'fact', projectId: PROJECT_ID, status: 'current', updatedAt: CREATED_AT });
  await projects.saveDecision({ createdAt: CREATED_AT, decidedAt: CREATED_AT, id: 'decision-1', projectId: PROJECT_ID, statement: 'Old choice', status: 'active', updatedAt: CREATED_AT });
  let sequence = 1;
  const service = new ProjectService(projects, { createId: () => `generated-${sequence++}`, now: () => new Date(OPERATION_AT) });
  await service.supersedeKnowledge('knowledge-1', { content: 'New fact', id: 'knowledge-2', kind: 'fact' });
  await service.supersedeDecision('decision-1', { id: 'decision-2', statement: 'New choice' });

  const fresh = repository(database);
  assert.equal((await fresh.getKnowledgeItem('knowledge-1')).status, 'superseded');
  assert.equal((await fresh.getKnowledgeItem('knowledge-2')).supersedesKnowledgeItemId, 'knowledge-1');
  assert.equal((await fresh.getDecision('decision-1')).status, 'superseded');
  assert.equal((await fresh.getDecision('decision-2')).supersedesDecisionId, 'decision-1');
});

test('migration enables owner RLS and derives atomic-write ownership from auth.uid()', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20260813150000_create_project_persistence.sql', import.meta.url), 'utf8');
  const tables = Object.values(CHANGE_TABLES).filter(
    (table) => table !== 'project_sections',
  );
  for (const table of tables) assert.match(migration, new RegExp(`create table public\\.${table}`));
  assert.match(migration, /enable row level security/);
  assert.match(migration, /owner_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /authenticated_owner uuid := auth\.uid\(\)/);
  assert.match(migration, /value \|\| jsonb_build_object\('owner_id', authenticated_owner\)/);
  assert.match(migration, /revoke all on table public\.%I from anon/);
  assert.doesNotMatch(migration, /service_role/);
  assert.equal((migration.match(/enable row level security/g) ?? []).length, 1);
  assert.match(migration, /security definer\s+set search_path = ''/);
});

test('section migration binds ownership, backfills Overview, and exposes only scoped safe writes', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20260826120000_create_project_sections.sql', import.meta.url), 'utf8');
  assert.match(migration, /create table public\.project_sections/);
  assert.match(migration, /foreign key \(owner_id, project_id\)\s+references public\.projects\(owner_id, id\)/);
  assert.match(migration, /create unique index project_sections_one_default_idx/);
  assert.match(migration, /create unique index project_sections_active_title_idx/);
  assert.match(migration, /'project-section-overview:' \|\| id/);
  assert.match(migration, /on conflict \(owner_id, id\) do nothing/);
  assert.match(migration, /project_sections_owner_access/);
  assert.match(migration, /owner_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /project_sections_protect_identity/);
  assert.match(migration, /new\.project_id is distinct from old\.project_id/);
  assert.match(migration, /grant select, insert, update on table public\.project_sections/);
  assert.doesNotMatch(migration, /grant .*delete.*project_sections/i);
  assert.match(migration, /create function public\.reorder_project_sections/);
  assert.match(migration, /perform private\.upsert_owned_project_rows\('public\.project_sections'/);
});
