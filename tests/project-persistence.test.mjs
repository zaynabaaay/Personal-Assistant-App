import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ProjectService } from '../src/services/projects/project-service.ts';
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
      rpc: async (name, { p_changes: changes }) => {
        assert.equal(name, 'commit_project_changes');
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
  await first.saveWorkSessionEntry({ content: 'Unmodified raw thought', id: 'entry-1', kind: 'user_message', occurredAt: CREATED_AT, position: 1, sessionId: 'session-1' });

  const fresh = repository(database);
  assert.deepEqual(await fresh.getProject(PROJECT_ID), project());
  assert.equal((await fresh.listMilestones(PROJECT_ID))[0].id, 'milestone-1');
  assert.equal((await fresh.listDeliverables(PROJECT_ID))[0].milestoneId, 'milestone-1');
  assert.equal((await fresh.listTasks(PROJECT_ID))[0].sourceSessionId, 'session-1');
  assert.equal((await fresh.listKnowledgeItems(PROJECT_ID))[0].content, 'A durable fact');
  assert.equal((await fresh.listDecisions(PROJECT_ID))[0].statement, 'Keep the model');
  assert.equal((await fresh.listResources(PROJECT_ID))[0].externalUrl, 'https://example.com');
  assert.deepEqual(await fresh.listWorkSessionEntries('session-1'), [{ content: 'Unmodified raw thought', id: 'entry-1', kind: 'user_message', occurredAt: CREATED_AT, position: 1, sessionId: 'session-1' }]);
});

test('repository reads are isolated to the authenticated owner', async () => {
  const database = new FakeSupabaseDatabase();
  await repository(database, OWNER_A).saveProject(project());
  assert.equal(await repository(database, OWNER_B).getProject(PROJECT_ID), null);
  assert.deepEqual(await repository(database, OWNER_B).listProjects(), []);
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
  const tables = Object.values(CHANGE_TABLES);
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
