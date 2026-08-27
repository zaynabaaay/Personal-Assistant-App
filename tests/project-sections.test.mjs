import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ProjectDomainError } from '../src/domain/projects/project-rules.ts';
import { InMemoryProjectRepository } from '../src/services/projects/in-memory-project-repository.ts';
import {
  ProjectService,
  projectOverviewSectionId,
} from '../src/services/projects/project-service.ts';

const AT = '2026-08-26T16:00:00.000Z';
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function project(id, overrides = {}) {
  return {
    createdAt: AT, id, name: id, priority: 'normal', status: 'active',
    timezone: 'America/Toronto', type: 'general', updatedAt: AT, ...overrides,
  };
}

function serviceFor(seed = {}) {
  let sequence = 1;
  const repository = new InMemoryProjectRepository(seed);
  const service = new ProjectService(repository, {
    createId: () => `generated-${sequence++}`,
    now: () => new Date(Date.parse(AT) + sequence * 1_000),
  });
  return { repository, service };
}

test('existing Project initialization creates exactly one retry-safe Overview', async () => {
  const { repository, service } = serviceFor({ projects: [project('aqal')] });
  const first = await service.ensureOverviewSection('aqal');
  const second = await service.ensureOverviewSection('aqal');
  const sections = await repository.listSections('aqal');

  assert.equal(first.id, projectOverviewSectionId('aqal'));
  assert.equal(second.id, first.id);
  assert.deepEqual(sections, [{
    createdAt: first.createdAt,
    id: 'project-section-overview:aqal',
    isDefault: true,
    position: 0,
    projectId: 'aqal',
    status: 'active',
    title: 'Overview',
    updatedAt: first.updatedAt,
  }]);
});

test('new Project creation atomically includes exactly one Overview', async () => {
  const { repository, service } = serviceFor();
  const created = await service.createProject({
    description: 'A community program.', name: 'AQAL', status: 'active',
    timezone: 'America/Toronto',
  });
  const sections = await repository.listSections(created.value.id);

  assert.equal(created.outcome, 'created');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, 'Overview');
  assert.equal(sections[0].isDefault, true);
  assert.equal(sections[0].projectId, created.value.id);
});

test('custom sections validate and persist user titles while preventing duplicate active titles', async () => {
  const { repository, service } = serviceFor({ projects: [project('aqal')] });
  await service.ensureOverviewSection('aqal');
  const materials = await service.addSection('aqal', '  Materials  ');

  assert.equal(materials.value.title, 'Materials');
  assert.equal((await repository.getSection(materials.value.id))?.title, 'Materials');
  await assert.rejects(service.addSection('aqal', '   '), ProjectDomainError);
  await assert.rejects(service.addSection('aqal', 'x'.repeat(49)), /48 characters/);
  await assert.rejects(service.addSection('aqal', ' materials '), /already exists/);
  assert.equal((await repository.listSections('aqal')).length, 2);
});

test('custom sections rename and reorder authoritatively with Overview fixed first', async () => {
  const { repository, service } = serviceFor({ projects: [project('aqal')] });
  const overview = await service.ensureOverviewSection('aqal');
  const materials = (await service.addSection('aqal', 'Materials')).value;
  const budget = (await service.addSection('aqal', 'Budget')).value;
  const renamed = await service.renameSection('aqal', materials.id, 'Textiles');
  const reordered = await service.reorderSections('aqal', [overview.id, budget.id, materials.id]);

  assert.equal(renamed.value.title, 'Textiles');
  assert.deepEqual(reordered.map(({ title }) => title), ['Overview', 'Budget', 'Textiles']);
  assert.deepEqual(
    (await repository.listSections('aqal')).filter(({ status }) => status === 'active')
      .map(({ title, position }) => [title, position]),
    [['Overview', 0], ['Budget', 1], ['Textiles', 2]],
  );
  await assert.rejects(
    service.reorderSections('aqal', [budget.id, overview.id, materials.id]),
    /Overview must remain first/,
  );
});

test('archive hides a custom section, restore appends it, and Overview is protected', async () => {
  const { service } = serviceFor({ projects: [project('aqal')] });
  const overview = await service.ensureOverviewSection('aqal');
  const materials = (await service.addSection('aqal', 'Materials')).value;
  await service.addSection('aqal', 'Budget');

  await service.archiveSection('aqal', materials.id);
  assert.deepEqual(
    (await service.listSections('aqal')).filter(({ status }) => status === 'active')
      .map(({ title }) => title),
    ['Overview', 'Budget'],
  );
  const restored = await service.restoreSection('aqal', materials.id);
  assert.equal(restored.value.status, 'active');
  assert.equal(restored.value.position, 3);
  await assert.rejects(service.archiveSection('aqal', overview.id), /cannot be archived/);
  await assert.rejects(service.renameSection('aqal', overview.id, 'Home'), /cannot be renamed/);
});

test('restore refuses an active title collision without duplicating the archived section', async () => {
  const { repository, service } = serviceFor({ projects: [project('aqal')] });
  await service.ensureOverviewSection('aqal');
  const first = (await service.addSection('aqal', 'Materials')).value;
  await service.archiveSection('aqal', first.id);
  await service.addSection('aqal', 'Materials');

  await assert.rejects(service.restoreSection('aqal', first.id), /already exists/);
  assert.equal((await repository.getSection(first.id))?.status, 'archived');
});

test('section mutation and reorder cannot cross Project boundaries', async () => {
  const { repository, service } = serviceFor({ projects: [project('aqal'), project('comic')] });
  const aqalOverview = await service.ensureOverviewSection('aqal');
  const comicOverview = await service.ensureOverviewSection('comic');
  const materials = (await service.addSection('aqal', 'Materials')).value;
  const characters = (await service.addSection('comic', 'Characters')).value;

  await assert.rejects(service.renameSection('comic', materials.id, 'World'), /does not belong/);
  await assert.rejects(service.archiveSection('comic', materials.id), /does not belong/);
  await assert.rejects(service.restoreSection('comic', materials.id), /does not belong/);
  await assert.rejects(
    service.reorderSections('aqal', [aqalOverview.id, characters.id]),
    /every active section in this Project/,
  );
  assert.deepEqual(
    (await repository.listSections('comic')).map(({ id }) => id),
    [comicOverview.id, characters.id],
  );
});

test('section operations leave existing Project intelligence and provenance untouched', async () => {
  const decision = { createdAt: AT, decidedAt: AT, id: 'decision', projectId: 'aqal', statement: 'Keep it community-led.', status: 'active', updatedAt: AT };
  const question = { content: 'Which venue?', createdAt: AT, id: 'question', kind: 'question', projectId: 'aqal', status: 'current', updatedAt: AT };
  const task = { createdAt: AT, id: 'task', position: 0, priority: 'normal', projectId: 'aqal', status: 'todo', title: 'Call venue', updatedAt: AT };
  const session = { createdAt: AT, endedAt: AT, id: 'session', projectId: 'aqal', startedAt: AT, summary: 'Discussed venue.', updatedAt: AT };
  const resource = { createdAt: AT, id: 'resource', name: 'Brief', projectId: 'aqal', role: 'reference', type: 'document', updatedAt: AT };
  const { repository, service } = serviceFor({ decisions: [decision], knowledgeItems: [question], projects: [project('aqal')], resources: [resource], tasks: [task], workSessions: [session] });

  await service.ensureOverviewSection('aqal');
  const section = (await service.addSection('aqal', 'Materials')).value;
  await service.renameSection('aqal', section.id, 'Textiles');
  await service.archiveSection('aqal', section.id);
  await service.restoreSection('aqal', section.id);

  assert.deepEqual(await repository.listDecisions('aqal'), [decision]);
  assert.deepEqual(await repository.listKnowledgeItems('aqal'), [question]);
  assert.deepEqual(await repository.listTasks('aqal'), [task]);
  assert.deepEqual(await repository.listResources('aqal'), [resource]);
  assert.deepEqual(await repository.listWorkSessions('aqal'), [session]);
});

test('Project UI uses persisted ordered sections without changing Tina or work-session scope', async () => {
  const [screen, navigation, manager, routing, chat] = await Promise.all([
    read('../src/features/projects/project-screen.tsx'),
    read('../src/features/projects/project-section-navigation.tsx'),
    read('../src/features/projects/project-sections-manager.tsx'),
    read('../src/server/assistant/project-scope-routing.ts'),
    read('../src/services/projects/project-chat-service.ts'),
  ]);

  assert.match(screen, /projectService\.listSections\(id\)/);
  assert.match(screen, /sections=\{activeSections\}/);
  assert.match(screen, /setSelectedSectionId\(section\.id\)/);
  assert.match(navigation, /sections\.map/);
  assert.doesNotMatch(screen, /Materials|Manufacturers|Budget|Characters|World|Plot|Artwork|Research/);
  assert.match(screen, /testID="project-custom-section-surface"/);
  assert.match(screen, /testID="manage-project-sections"/);
  assert.match(manager, /archiveSection|restoreSection|reorderSections|renameSection|addSection/);
  assert.doesNotMatch(manager, /Decision|Question|Task|resource|work session/i);
  assert.doesNotMatch(routing, /section/i);
  assert.doesNotMatch(chat, /section/i);
  assert.match(screen, /projectId: project\.id/);
  assert.match(screen, /projectName: project\.name/);
  assert.match(screen, /projectChatService\.startNewSession\(session\)/);
});
