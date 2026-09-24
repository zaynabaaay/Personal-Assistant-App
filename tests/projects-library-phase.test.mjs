import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { projectLibraryCollections, sortProjects } from '../src/features/projects/project-presentation.ts';
import { InMemoryProjectRepository } from '../src/services/projects/in-memory-project-repository.ts';
import { ProjectAssetService } from '../src/services/projects/project-asset-service.ts';
import { ProjectChatService } from '../src/services/projects/project-chat-service.ts';
import { ProjectService } from '../src/services/projects/project-service.ts';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const AT = '2026-08-27T10:00:00.000Z';
const LATER = '2026-08-27T11:00:00.000Z';

function project(id, overrides = {}) {
  return {
    createdAt: AT, id, name: id, priority: 'normal', status: 'planned',
    timezone: 'America/Toronto', type: 'general', updatedAt: AT, ...overrides,
  };
}

function section(id, projectId, overrides = {}) {
  return {
    createdAt: AT, id, isDefault: id === 'overview', position: id === 'overview' ? 0 : 1,
    projectId, status: 'active', title: id, updatedAt: AT, ...overrides,
  };
}

test('two-destination shell makes Projects direct while retaining mounted conversation state', async () => {
  const [shell, home, drawer] = await Promise.all([
    read('../src/app/(shell)/_layout.tsx'),
    read('../src/features/home/home-screen.tsx'),
    read('../src/features/home/chats-drawer.tsx'),
  ]);
  assert.match(shell, /<Tabs/);
  assert.match(shell, /name="index"/);
  assert.match(shell, /name="projects\/index"/);
  assert.match(shell, /lazy: false/);
  assert.match(shell, /detachInactiveScreens=\{false\}/);
  assert.match(shell, /tabBarHideOnKeyboard: true/);
  assert.match(shell, /tabBarAccessibilityLabel: 'Projects library'/);
  assert.doesNotMatch(shell, /Profile|Settings|Dashboard|Account/);
  assert.match(home, /const \[draft, setDraft\] = useState\(''\)/);
  assert.match(home, /finishConversationLifecycle/);
  assert.doesNotMatch(shell, /finishConversation|finishConversationLifecycle|resetActiveConversation/);
  assert.doesNotMatch(drawer, /onOpenProjects|open-projects/);
  assert.match(drawer, /Open full Chats/);
});

test('library unifies normal statuses and preserves archived lifecycle separately', () => {
  const values = [project('planned'), project('paused', { status: 'paused' }),
    project('done', { status: 'completed' }), project('archive', { status: 'archived' })];
  const result = projectLibraryCollections(values, 'recent');
  assert.deepEqual(result.projects.map(({ id }) => id).sort(), ['done', 'paused', 'planned']);
  assert.deepEqual(result.archived.map(({ id }) => id), ['archive']);
  assert.equal(values.find(({ id }) => id === 'paused').status, 'paused');
});

test('all library sorts use deterministic tie-breakers', () => {
  const values = [
    project('2', { createdAt: '2026-08-25T00:00:00.000Z', name: 'Beta', updatedAt: LATER }),
    project('1', { createdAt: '2026-08-26T00:00:00.000Z', name: 'beta', updatedAt: LATER }),
    project('3', { createdAt: '2026-08-26T00:00:00.000Z', name: 'Alpha', updatedAt: AT }),
  ];
  assert.deepEqual(sortProjects(values, 'recent').map(({ id }) => id), ['1', '2', '3']);
  assert.deepEqual(sortProjects(values, 'created').map(({ id }) => id), ['1', '3', '2']);
  assert.deepEqual(sortProjects(values, 'name').map(({ id }) => id), ['3', '2', '1']);
});

test('section creation and meaningful rename touch Project recency without changing status', async () => {
  let now = new Date(LATER);
  const repository = new InMemoryProjectRepository({ projects: [project('p')], sections: [section('overview', 'p')] });
  const service = new ProjectService(repository, { createId: () => 'materials', now: () => now });
  const created = await service.addSection('p', 'Materials');
  assert.equal((await repository.getProject('p')).updatedAt, LATER);
  assert.equal((await repository.getProject('p')).status, 'planned');
  now = new Date('2026-08-27T12:00:00.000Z');
  await service.renameSection('p', created.value.id, 'Sources');
  assert.equal((await repository.getProject('p')).updatedAt, '2026-08-27T12:00:00.000Z');
});

test('Project chat messages touch recency but passive session loading does not', async () => {
  let now = new Date(LATER);
  const repository = new InMemoryProjectRepository({ projects: [project('p')] });
  const chat = new ProjectChatService(repository, () => now);
  const loaded = await chat.load('p');
  assert.equal((await repository.getProject('p')).updatedAt, AT);
  await chat.load('p');
  assert.equal((await repository.listWorkSessions('p')).length, 1);
  await chat.append(loaded.session, 'user_message', 'Meaningful work', 0);
  assert.equal((await repository.getProject('p')).updatedAt, LATER);
});

test('asset creation, rename, and Move touch recency; lifecycle-only changes do not', async () => {
  let now = new Date(LATER);
  const repository = new InMemoryProjectRepository({
    ownerId: 'owner', projects: [project('p')],
    sections: [section('overview', 'p'), section('materials', 'p')],
  });
  const objects = new Map();
  let id = 0;
  const assets = new ProjectAssetService(repository, {
    createId: () => `asset-${++id}`,
    loadBinary: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    now: () => now,
    storage: {
      createSignedUrl: async () => ({ expiresAt: Date.now() + 1000, url: 'https://example.test' }),
      remove: async (path) => { objects.delete(path); },
      upload: async (path, bytes) => { objects.set(path, bytes); },
    },
  });
  const asset = await assets.upload('p', 'materials', {
    height: 1, mimeType: 'image/png', name: 'source.png', size: 4,
    source: 'photo-library', uri: 'memory://source', width: 1,
  });
  assert.equal((await repository.getProject('p')).updatedAt, LATER);
  now = new Date('2026-08-27T12:00:00.000Z');
  await assets.rename('p', asset.id, 'Reference image');
  assert.equal((await repository.getProject('p')).updatedAt, '2026-08-27T12:00:00.000Z');
  now = new Date('2026-08-27T13:00:00.000Z');
  await assets.reassign('p', asset.id, 'overview');
  const movedAt = (await repository.getProject('p')).updatedAt;
  assert.ok(movedAt > '2026-08-27T12:00:00.000Z');
  await assets.archive('p', asset.id);
  await assets.restore('p', asset.id);
  assert.equal((await repository.getProject('p')).updatedAt, movedAt);
});

test('finalized asset remains successful when only Project activity touching fails', async () => {
  const repository = new InMemoryProjectRepository({
    ownerId: 'owner', projects: [project('p')], sections: [section('overview', 'p')],
  });
  repository.touchProjectActivity = async () => { throw new Error('missing activity RPC'); };
  const diagnostics = [];
  let id = 0;
  const assets = new ProjectAssetService(repository, {
    createId: () => `asset-${++id}`,
    loadBinary: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    now: () => new Date(LATER),
    onActivityTouchError: (diagnostic) => diagnostics.push(diagnostic),
    storage: {
      createSignedUrl: async () => ({ expiresAt: Date.now() + 1000, url: 'https://example.test' }),
      remove: async () => undefined,
      upload: async () => undefined,
    },
  });

  const asset = await assets.upload('p', 'overview', {
    height: 1, mimeType: 'image/png', name: 'source.png', size: 4,
    source: 'photo-library', uri: 'memory://source', width: 1,
  });

  assert.equal((await repository.getResource(asset.id))?.id, asset.id);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].projectId, 'p');
  assert.match(diagnostics[0].cause.message, /missing activity RPC/);
});

test('persisted Project chat remains successful when only activity touching fails', async () => {
  const repository = new InMemoryProjectRepository({ projects: [project('p')] });
  repository.touchProjectActivity = async () => { throw new Error('missing activity RPC'); };
  const diagnostics = [];
  const activity = new ProjectService(repository, {
    now: () => new Date(LATER),
    onActivityTouchError: (diagnostic) => diagnostics.push(diagnostic),
  });
  const chat = new ProjectChatService(repository, () => new Date(LATER), activity);
  const loaded = await chat.load('p');

  const entry = await chat.append(loaded.session, 'user_message', 'Keep working', 0);

  assert.deepEqual(await repository.listWorkSessionEntries(loaded.session.id), [entry]);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].cause.message, /missing activity RPC/);
});

test('section creation remains successful and reports a separate recency diagnostic', async () => {
  const repository = new InMemoryProjectRepository({
    projects: [project('p')], sections: [section('overview', 'p')],
  });
  repository.touchProjectActivity = async () => { throw new Error('missing activity RPC'); };
  const diagnostics = [];
  const service = new ProjectService(repository, {
    createId: () => 'materials', now: () => new Date(LATER),
    onActivityTouchError: (diagnostic) => diagnostics.push(diagnostic),
  });

  const created = await service.addSection('p', 'Materials');

  assert.equal((await repository.getSection(created.value.id))?.title, 'Materials');
  assert.equal(diagnostics.length, 1);
});

test('failed asset and chat primary persistence never attempt Project recency', async () => {
  const repository = new InMemoryProjectRepository({
    ownerId: 'owner', projects: [project('p')], sections: [section('overview', 'p')],
  });
  let touches = 0;
  repository.touchProjectActivity = async () => { touches += 1; };
  let id = 0;
  const assets = new ProjectAssetService(repository, {
    createId: () => `asset-${++id}`,
    loadBinary: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    now: () => new Date(LATER),
    storage: {
      createSignedUrl: async () => ({ expiresAt: Date.now() + 1000, url: 'https://example.test' }),
      remove: async () => undefined,
      upload: async () => { throw new Error('binary upload failed'); },
    },
  });
  await assert.rejects(assets.upload('p', 'overview', {
    height: 1, mimeType: 'image/png', name: 'source.png', size: 4,
    source: 'photo-library', uri: 'memory://source', width: 1,
  }), /binary upload failed/);

  const chat = new ProjectChatService(repository, () => new Date(LATER));
  const loaded = await chat.load('p');
  repository.saveWorkSessionEntry = async () => { throw new Error('entry persistence failed'); };
  await assert.rejects(chat.append(loaded.session, 'user_message', 'Do not touch', 0), /entry persistence failed/);
  assert.equal(touches, 0);
});

test('passive listing, sorting, and section reorder do not touch recency', async () => {
  const repository = new InMemoryProjectRepository({
    projects: [project('p')], sections: [section('overview', 'p'), section('materials', 'p')],
  });
  const service = new ProjectService(repository, { now: () => new Date(LATER) });
  await repository.listProjects();
  sortProjects(await repository.listProjects(), 'name');
  await service.reorderSections('p', ['overview', 'materials']);
  assert.equal((await repository.getProject('p')).updatedAt, AT);
});

test('activity persistence reuses updated_at with a monotonic RLS-scoped boundary', async () => {
  const [migration, repository] = await Promise.all([
    read('../supabase/migrations/20260827140000_add_project_activity_touch.sql'),
    read('../src/services/projects/supabase-project-repository.ts'),
  ]);
  assert.match(migration, /create function public\.touch_project_activity/);
  assert.match(migration, /greatest\(updated_at, p_occurred_at\)/);
  assert.match(migration, /owner_id = authenticated_owner/);
  assert.doesNotMatch(migration, /last_opened_at|last_modified_at|add column/i);
  assert.match(repository, /rpc\('touch_project_activity'/);
});
