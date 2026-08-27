import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isAssistantApiRequest } from '../src/server/assistant/request-validation.ts';
import { AssistantService } from '../src/services/assistant/assistant-service.ts';
import { InMemoryProjectRepository } from '../src/services/projects/in-memory-project-repository.ts';
import { ProjectChatService } from '../src/services/projects/project-chat-service.ts';
import {
  groupProjects,
  projectDescription,
  projectFallbackInitial,
} from '../src/features/projects/project-presentation.ts';
import {
  createProjectViewPreference,
  PROJECT_VIEW_PREFERENCE_KEY,
} from '../src/features/projects/project-view-preference.ts';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const AT = '2026-08-26T12:00:00.000Z';

function project(id, status = 'active', overrides = {}) {
  return {
    createdAt: AT,
    description: `${id} description`,
    id,
    name: id === 'a' ? 'Atelier' : id === 'b' ? 'Bakery' : id,
    priority: 'normal',
    status,
    timezone: 'America/Toronto',
    type: 'general',
    updatedAt: AT,
    ...overrides,
  };
}

test('Project presentation uses persisted identity copy and a cover-free fallback', () => {
  assert.equal(projectDescription(project('a')), 'a description');
  assert.equal(projectDescription(project('a', 'active', { description: undefined })), 'No description yet.');
  assert.equal(projectFallbackInitial(project('a')), 'A');
});

test('Active, Paused, and Archived collections preserve existing status semantics', () => {
  const grouped = groupProjects([
    project('a', 'active'),
    project('b', 'paused'),
    project('c', 'archived'),
    project('d', 'planned'),
  ]);
  assert.deepEqual(grouped.active.map(({ id }) => id), ['a']);
  assert.deepEqual(grouped.paused.map(({ id }) => id), ['b']);
  assert.deepEqual(grouped.archived.map(({ id }) => id), ['c']);
  assert.deepEqual(grouped.other.map(({ id }) => id), ['d']);
});

test('list/grid preference loads safely and persists through the existing storage dependency', async () => {
  const values = new Map();
  const preference = createProjectViewPreference({
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
  });
  assert.equal(await preference.load(), 'list');
  await preference.save('grid');
  assert.equal(values.get(PROJECT_VIEW_PREFERENCE_KEY), 'grid');
  assert.equal(await preference.load(), 'grid');
});

test('Project chat uses persisted work-session provenance and never leaks sessions across Projects', async () => {
  const repository = new InMemoryProjectRepository({ projects: [project('a'), project('b')] });
  let sequence = 0;
  const chat = new ProjectChatService(repository, () => new Date(Date.parse(AT) + sequence++ * 1000));
  const first = await chat.load('a');
  await chat.append(first.session, 'user_message', 'Shape the first collection', 0);
  const second = await chat.load('b');
  await chat.append(second.session, 'user_message', 'Choose the bakery name', 0);

  assert.notEqual(first.session.id, second.session.id);
  assert.deepEqual((await chat.load('a')).entries.map(({ content }) => content), ['Shape the first collection']);
  assert.deepEqual((await chat.load('b')).entries.map(({ content }) => content), ['Choose the bakery name']);
  await assert.rejects(chat.append({ ...first.session, projectId: 'b' }, 'user_message', 'Leak', 1), /no longer available/);
});

test('Project New Chat closes the current session, preserves its evidence, and opens a clean scoped session', async () => {
  const repository = new InMemoryProjectRepository({
    decisions: [{
      createdAt: AT, decidedAt: AT, id: 'decision-a', projectId: 'a',
      statement: 'Keep the program community-led.', status: 'active', updatedAt: AT,
    }],
    knowledgeItems: [{
      content: 'Who will host the showcase?', createdAt: AT, id: 'question-a',
      kind: 'question', projectId: 'a', status: 'current', updatedAt: AT,
    }],
    projects: [project('a'), project('b')],
    resources: [{
      createdAt: AT, id: 'resource-a', name: 'Program notes', projectId: 'a',
      role: 'reference', type: 'document', updatedAt: AT,
    }],
    tasks: [{
      createdAt: AT, id: 'task-a', position: 0, priority: 'normal', projectId: 'a',
      status: 'in_progress', title: 'Confirm the venue', updatedAt: AT,
    }],
  });
  let sequence = 0;
  const chat = new ProjectChatService(
    repository,
    () => new Date(Date.parse(AT) + sequence++ * 1000),
  );
  const oldA = await chat.load('a');
  await chat.append(oldA.session, 'user_message', 'What are we working on?', 0);
  await chat.append(oldA.session, 'assistant_message', 'The AQAL program direction.', 1);
  const openB = await chat.load('b');
  await chat.append(openB.session, 'user_message', 'Keep this Bakery chat.', 0);

  const freshA = await chat.startNewSession(oldA.session);

  assert.notEqual(freshA.id, oldA.session.id);
  assert.equal(freshA.projectId, 'a');
  assert.equal(freshA.endedAt, undefined);
  assert.equal((await repository.getWorkSession(oldA.session.id))?.summary, 'Project chat ended with 2 messages.');
  assert.ok((await repository.getWorkSession(oldA.session.id))?.endedAt);
  assert.deepEqual(
    (await repository.listWorkSessionEntries(oldA.session.id)).map(({ content }) => content),
    ['What are we working on?', 'The AQAL program direction.'],
  );
  assert.deepEqual((await chat.load('a')).entries, []);
  assert.equal((await chat.load('a')).session.id, freshA.id);
  assert.equal((await repository.getWorkSession(openB.session.id))?.endedAt, undefined);
  assert.deepEqual(
    (await repository.listWorkSessionEntries(openB.session.id)).map(({ content }) => content),
    ['Keep this Bakery chat.'],
  );
  assert.equal((await repository.listDecisions('a')).length, 1);
  assert.equal((await repository.listKnowledgeItems('a')).length, 1);
  assert.equal((await repository.listTasks('a')).length, 1);
  assert.equal((await repository.listResources('a')).length, 1);
  assert.deepEqual(
    (await repository.listChangeEvents('a')).map(({ eventType }) => eventType),
    ['work_session_closed'],
  );
});

test('Project New Chat can recover after the old session was closed before fresh-session creation', async () => {
  const repository = new InMemoryProjectRepository({ projects: [project('a')] });
  let sequence = 0;
  const chat = new ProjectChatService(
    repository,
    () => new Date(Date.parse(AT) + sequence++ * 1000),
  );
  const old = await chat.load('a');
  await chat.append(old.session, 'user_message', 'Preserve this evidence.', 0);
  const originalSave = repository.saveWorkSession.bind(repository);
  let failFreshCreate = true;
  repository.saveWorkSession = async (value) => {
    if (value.id !== old.session.id && failFreshCreate) {
      failFreshCreate = false;
      throw new Error('interrupted');
    }
    return originalSave(value);
  };

  await assert.rejects(chat.startNewSession(old.session), /interrupted/);
  assert.ok((await repository.getWorkSession(old.session.id))?.endedAt);
  assert.deepEqual(
    (await repository.listWorkSessionEntries(old.session.id)).map(({ content }) => content),
    ['Preserve this evidence.'],
  );

  const recovered = await chat.startNewSession(old.session);
  assert.equal(recovered.projectId, 'a');
  assert.notEqual(recovered.id, old.session.id);
  assert.deepEqual(await repository.listWorkSessionEntries(recovered.id), []);
  assert.equal((await repository.listChangeEvents('a')).length, 1);
});

test('assistant Project scope is explicit, bounded, and forwarded independently per request', async () => {
  const requests = [];
  const assistant = new AssistantService(async (request) => { requests.push(request); return 'Okay'; });
  await assistant.respond([{ content: 'Continue here', role: 'user' }], { projectId: 'a', projectName: 'Atelier' });
  await assistant.respond([{ content: 'Continue here', role: 'user' }], { projectId: 'b', projectName: 'Bakery' });
  assert.deepEqual(requests.map((request) => request.projectScope?.projectId), ['a', 'b']);
  assert.deepEqual(requests.map((request) => request.projectScope?.projectName), ['Atelier', 'Bakery']);
  assert.equal(isAssistantApiRequest(requests[0]), true);
  assert.equal(isAssistantApiRequest({ ...requests[0], projectScope: { projectId: '' } }), false);
});

test('Projects library and creation UI surface only supported persisted identity fields', async () => {
  const [library, creation] = await Promise.all([
    read('../src/features/projects/projects-screen.tsx'),
    read('../src/features/projects/new-project-screen.tsx'),
  ]);
  const item = library.slice(library.indexOf('function ProjectItem'), library.indexOf('function ProjectSection'));
  assert.match(item, /project\.name/);
  assert.match(item, /projectDescription\(project\)/);
  assert.doesNotMatch(item, /project\.status|task|progress|updatedAt|file/i);
  assert.match(library, /testID=\{`projects-\$\{value\}-view`\}/);
  assert.match(library, /\(\['list', 'grid'\] as const\)/);
  assert.match(library, /testID="project-cover-fallback"/);
  assert.match(creation, /projectService\.createProject/);
  assert.match(creation, /description: description\.trim\(\)/);
  assert.match(creation, /status: 'active'/);
  assert.doesNotMatch(creation, /milestone|template|progress|category/i);
});

test('opening a Project enters an identity-first workspace with Overview', async () => {
  const [screen, route] = await Promise.all([
    read('../src/features/projects/project-screen.tsx'),
    read('../src/app/projects/[id]/index.tsx'),
  ]);
  assert.match(route, /ProjectScreen/);
  assert.match(screen, /testID="project-identity"/);
  assert.match(screen, /project\.name/);
  assert.match(screen, /project\.description/);
  assert.match(screen, /testID="project-home-cover-fallback"/);
  assert.match(screen, /testID="project-overview-section"/);
  assert.match(screen, /<ProjectSectionNavigation/);
  assert.doesNotMatch(screen, /open-project-workspace|pathname: '\/projects\/\[id\]\/workspace'/);
});

test('Project-scoped Tina expands inside the workspace and reuses composer behavior', async () => {
  const screen = await read('../src/features/projects/project-screen.tsx');
  assert.match(screen, /testID="project-tina-control"/);
  assert.match(screen, /testID="open-project-tina"/);
  assert.match(screen, /<MessageComposer/);
  assert.match(screen, /messageSendEnabled\(draft/);
  assert.match(screen, /KeyboardAvoidingView/);
  assert.match(screen, /projectId: project\.id/);
  assert.match(screen, /projectName: project\.name/);
  assert.match(screen, /projectChatService\.load\(id\)/);
  assert.doesNotMatch(screen, /Right now|current state|current context/i);
});

test('Project Ask Tina exposes a non-destructive scoped New Chat without touching main or other drafts', async () => {
  const [projectScreen, homeScreen] = await Promise.all([
    read('../src/features/projects/project-screen.tsx'),
    read('../src/features/home/home-screen.tsx'),
  ]);
  const start = projectScreen.indexOf('const startNewChat = async');
  const end = projectScreen.indexOf('\n\n  return (', start);
  const action = projectScreen.slice(start, end);

  assert.match(projectScreen, /testID="project-new-chat-button"/);
  assert.match(projectScreen, />\{startingNewChat \? 'Starting…' : 'New Chat'\}<\/Text>/);
  assert.doesNotMatch(projectScreen, />Clear<|accessibilityLabel="Clear/i);
  assert.match(action, /projectChatService\.startNewSession\(session\)/);
  assert.match(action, /setSession\(freshSession\)/);
  assert.match(action, /setEntries\(\[\]\)/);
  assert.match(action, /setDraft\(''\)/);
  assert.match(action, /assistantService\.resetSession\(\)/);
  assert.doesNotMatch(action, /activeConversationOutbox|conversationService|router|setProject/);
  assert.match(projectScreen, /projectId: project\.id/);
  assert.match(projectScreen, /projectName: project\.name/);
  assert.match(homeScreen, /testID="new-chat-button"/);
  assert.match(homeScreen, /finishConversationLifecycle/);
  assert.doesNotMatch(homeScreen, /projectChatService/);
});

test('section navigation is backed by genuine persisted Project sections', async () => {
  const [navigation, screen, types, service] = await Promise.all([
    read('../src/features/projects/project-section-navigation.tsx'),
    read('../src/features/projects/project-screen.tsx'),
    read('../src/domain/projects/project-types.ts'),
    read('../src/services/projects/project-service.ts'),
  ]);
  assert.match(navigation, /sections: readonly ProjectSectionDefinition\[\]/);
  assert.match(navigation, /sections\.map/);
  assert.match(screen, /projectService\.listSections\(id\)/);
  assert.match(screen, /sections=\{activeSections\}/);
  assert.match(types, /export type ProjectSection/);
  assert.match(service, /ensureOverviewSection/);
  assert.doesNotMatch(screen, /Materials|Manufacturers|Budget|Characters|Artwork|Venue/);
  assert.doesNotMatch(types, /Materials|Manufacturers|Budget|Characters|Artwork|Venue/);
});

test('the old schema-category Workspace is retired from primary navigation', async () => {
  const [screen, retiredRoute] = await Promise.all([
    read('../src/features/projects/project-screen.tsx'),
    read('../src/app/projects/[id]/workspace.tsx'),
  ]);
  assert.doesNotMatch(screen, /Decisions|Open Questions|Tasks|Chats|Files \/ Resources/);
  assert.match(retiredRoute, /<Redirect/);
  assert.match(retiredRoute, /pathname: '\/projects\/\[id\]'/);
});

test('structured intelligence and provenance remain in authoritative repositories', async () => {
  const [repository, processor, types] = await Promise.all([
    read('../src/services/projects/project-repository.ts'),
    read('../src/services/conversations/conversation-project-processor.ts'),
    read('../src/domain/projects/project-types.ts'),
  ]);
  assert.match(repository, /listDecisions/);
  assert.match(repository, /listKnowledgeItems/);
  assert.match(repository, /listTasks/);
  assert.match(repository, /listResources/);
  assert.match(repository, /listWorkSessions/);
  assert.match(repository, /listWorkSessionEntries/);
  assert.match(types, /sourceConversationId/);
  assert.match(types, /sourceSessionId/);
  assert.match(processor, /ConversationProjectProcessor/);
});

test('Project presentation adds no cover upload, fake state, or extraction rewrite', async () => {
  const [types, service, screen] = await Promise.all([
    read('../src/domain/projects/project-types.ts'),
    read('../src/services/projects/project-service.ts'),
    read('../src/features/projects/project-screen.tsx'),
  ]);
  assert.doesNotMatch(types, /cover|idea/i);
  assert.doesNotMatch(service, /cover|idea/i);
  assert.doesNotMatch(screen, /generate.*state|synthesi[sz]e|decision.*task.*question/i);
});
