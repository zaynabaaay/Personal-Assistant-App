import type {
  AssistantProjectContextFocus,
  AssistantProjectContextResult,
  AssistantProjectListResult,
  AssistantProjectSummary,
  AssistantProjectToolCall,
  AssistantProjectToolOutput,
} from '../../contracts/assistant';
import { selectCurrentAcceptedKnowledge } from '../../domain/projects';
import type { Project } from '../../domain/projects';
import type { ProjectRepository } from '../../services/projects/project-repository';
import {
  createServerProjectRepository,
  type ServerProjectRepositoryContext,
} from '../projects/server-project-repository';

const LIMITS = {
  changes: 15,
  decisions: 15,
  deliverables: 20,
  knowledge: 20,
  milestones: 12,
  projects: 20,
  questions: 15,
  resources: 15,
  sessions: 10,
  tasks: 20,
} as const;
const MAX_RESULT_CHARACTERS = 44_000;
const ARRAY_SECTIONS = [
  'openTasks', 'milestones', 'deliverables', 'currentKnowledge',
  'unresolvedQuestions', 'currentDecisions', 'recentWorkSessions', 'resources',
  'recentChanges',
] as const;

type ProjectRepositoryFactory = (
  context: ServerProjectRepositoryContext,
) => ProjectRepository;

function truncate(value: string | undefined, maximum: number) {
  if (!value) return undefined;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function optional<T extends object>(key: string, value: unknown): Partial<T> {
  return value === undefined ? {} : { [key]: value } as Partial<T>;
}

function projectSummary(project: Project): AssistantProjectSummary {
  return {
    ...optional<AssistantProjectSummary>('completedAt', project.completedAt),
    ...optional<AssistantProjectSummary>('description', truncate(project.description, 800)),
    ...optional<AssistantProjectSummary>('goal', truncate(project.goal, 500)),
    id: project.id,
    name: truncate(project.name, 300) ?? project.name,
    priority: project.priority,
    ...optional<AssistantProjectSummary>('startDate', project.startDate),
    status: project.status,
    ...optional<AssistantProjectSummary>('targetDate', project.targetDate),
    timezone: truncate(project.timezone, 100) ?? project.timezone,
    type: project.type,
    updatedAt: project.updatedAt,
  } as AssistantProjectSummary;
}

function takeRecent<T>(
  values: readonly T[],
  limit: number,
  date: (value: T) => string,
) {
  return [...values]
    .sort((left, right) => date(right).localeCompare(date(left)))
    .slice(0, limit);
}

function addTruncated(
  sections: string[],
  name: string,
  count: number,
  limit: number,
) {
  if (count > limit) sections.push(name);
}

function errorResult(): { message: string; status: 'error' } {
  return { message: 'Project information is temporarily unavailable.', status: 'error' };
}

function fitResult(result: Extract<AssistantProjectContextResult, { status: 'success' }>) {
  while (JSON.stringify(result).length > MAX_RESULT_CHARACTERS) {
    const section = ARRAY_SECTIONS
      .filter((name) => (result[name]?.length ?? 0) > 0)
      .sort((left, right) =>
        JSON.stringify(result[right]).length - JSON.stringify(result[left]).length,
      )[0];

    if (!section) break;
    result[section]?.pop();
    if (!result.truncatedSections.includes(section)) {
      result.truncatedSections.push(section);
    }
  }

  return result;
}

async function listProjects(
  repository: ProjectRepository,
  includeArchived: boolean,
): Promise<AssistantProjectListResult> {
  const allProjects = (await repository.listProjects())
    .filter((project) => includeArchived || project.status !== 'archived')
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name),
    );

  return {
    projects: allProjects.slice(0, LIMITS.projects).map(projectSummary),
    status: 'success',
    truncated: allProjects.length > LIMITS.projects,
  };
}

function wants(focus: AssistantProjectContextFocus, section: 'work' | 'knowledge' | 'history') {
  return focus === section || focus === 'comprehensive' ||
    (focus === 'overview' && (section === 'work' || section === 'history'));
}

async function getProjectContext(
  repository: ProjectRepository,
  projectId: string,
  focus: AssistantProjectContextFocus,
): Promise<AssistantProjectContextResult> {
  const project = await repository.getProject(projectId);
  if (!project) return { message: 'That Project was not found.', status: 'not_found' };

  const includeWork = wants(focus, 'work');
  const includeKnowledge = wants(focus, 'knowledge');
  const includeHistory = wants(focus, 'history');
  const [tasks, milestones, deliverables, knowledge, decisions, sessions, resources, sections, changes] =
    await Promise.all([
      includeWork ? repository.listTasks(projectId) : [],
      includeWork ? repository.listMilestones(projectId) : [],
      includeWork ? repository.listDeliverables(projectId) : [],
      includeKnowledge ? repository.listKnowledgeItems(projectId) : [],
      includeKnowledge ? repository.listDecisions(projectId) : [],
      includeWork || includeHistory ? repository.listWorkSessions(projectId) : [],
      includeKnowledge ? repository.listResources(projectId) : [],
      includeKnowledge ? repository.listSections(projectId) : [],
      includeHistory ? repository.listChangeEvents(projectId) : [],
    ]);
  const truncatedSections: string[] = [];
  const result: AssistantProjectContextResult = {
    focus,
    project: projectSummary(project),
    status: 'success',
    truncatedSections,
  };

  if (includeWork) {
    const openTasks = tasks.filter((task) =>
      task.status !== 'completed' && task.status !== 'cancelled');
    addTruncated(truncatedSections, 'openTasks', openTasks.length, LIMITS.tasks);
    addTruncated(truncatedSections, 'milestones', milestones.length, LIMITS.milestones);
    addTruncated(truncatedSections, 'deliverables', deliverables.length, LIMITS.deliverables);
    result.openTasks = openTasks.slice(0, LIMITS.tasks).map((task) => ({
      ...optional('deliverableId', task.deliverableId),
      ...optional('description', truncate(task.description, 600)),
      ...optional('dueDate', task.dueDate),
      id: task.id,
      ...optional('milestoneId', task.milestoneId),
      position: task.position,
      priority: task.priority,
      ...optional('scheduledFor', task.scheduledFor),
      status: task.status,
      title: truncate(task.title, 300) ?? task.title,
    }));
    result.milestones = milestones.slice(0, LIMITS.milestones).map((value) => ({
      ...optional('description', truncate(value.description, 600)), id: value.id,
      name: truncate(value.name, 300) ?? value.name, position: value.position,
      status: value.status, ...optional('targetDate', value.targetDate),
    }));
    result.deliverables = deliverables.slice(0, LIMITS.deliverables).map((value) => ({
      ...optional('description', truncate(value.description, 600)),
      ...optional('dueDate', value.dueDate), id: value.id,
      ...optional('milestoneId', value.milestoneId),
      name: truncate(value.name, 300) ?? value.name, position: value.position,
      status: value.status,
    }));
  }

  if (includeKnowledge) {
    const accepted = selectCurrentAcceptedKnowledge(knowledge);
    const questions = knowledge.filter((item) =>
      item.status === 'current' && item.kind === 'question');
    const currentDecisions = decisions.filter((decision) => decision.status === 'active');
    addTruncated(truncatedSections, 'currentKnowledge', accepted.length, LIMITS.knowledge);
    addTruncated(truncatedSections, 'unresolvedQuestions', questions.length, LIMITS.questions);
    addTruncated(truncatedSections, 'currentDecisions', currentDecisions.length, LIMITS.decisions);
    addTruncated(truncatedSections, 'resources', resources.length, LIMITS.resources);
    const mapKnowledge = (item: typeof knowledge[number]) => ({
      content: truncate(item.content, 1_200) ?? item.content, id: item.id, kind: item.kind,
      ...optional('title', truncate(item.title, 300)), updatedAt: item.updatedAt,
    });
    result.currentKnowledge = accepted.slice(0, LIMITS.knowledge).map(mapKnowledge);
    result.unresolvedQuestions = questions.slice(0, LIMITS.questions).map(mapKnowledge);
    result.currentDecisions = currentDecisions.slice(0, LIMITS.decisions).map((value) => ({
      decidedAt: value.decidedAt, id: value.id,
      ...optional('rationale', truncate(value.rationale, 1_000)),
      statement: truncate(value.statement, 1_000) ?? value.statement,
    }));
    result.resources = resources.slice(0, LIMITS.resources).map((value) => ({
      ...optional('byteSize', value.byteSize),
      ...optional('createdAt', value.storagePath ? value.createdAt : undefined),
      ...optional('description', truncate(value.description, 600)),
      ...optional('externalUrl', truncate(value.externalUrl, 1_000)), id: value.id,
      ...optional('mimeType', truncate(value.mimeType, 200)),
      name: truncate(value.name, 300) ?? value.name,
      ...optional('originalFilename', truncate(value.originalFilename, 300)),
      role: value.role, ...optional('sectionId', value.sectionId),
      ...optional('sectionTitle', sections.find((section) => section.id === value.sectionId)?.title),
      ...optional('status', value.status), type: value.type,
    }));
  }

  if (includeWork || includeHistory) {
    addTruncated(truncatedSections, 'recentWorkSessions', sessions.length, LIMITS.sessions);
    result.recentWorkSessions = takeRecent(
      sessions, LIMITS.sessions, (session) => session.startedAt,
    ).map((value) => ({
      ...optional('endedAt', value.endedAt), id: value.id, startedAt: value.startedAt,
      ...optional('summary', truncate(value.summary, 1_000)),
      ...optional('title', truncate(value.title, 300)),
    }));
  }

  if (includeHistory) {
    addTruncated(truncatedSections, 'recentChanges', changes.length, LIMITS.changes);
    result.recentChanges = takeRecent(
      changes, LIMITS.changes, (change) => change.occurredAt,
    ).map((value) => ({ entityType: value.entityType, eventType: value.eventType,
      id: value.id, occurredAt: value.occurredAt,
      summary: truncate(value.summary, 800) ?? value.summary }));
  }

  return fitResult(result);
}

export function createAssistantProjectToolExecutor(
  createRepository: ProjectRepositoryFactory = createServerProjectRepository,
) {
  return async (
    call: AssistantProjectToolCall,
    context: ServerProjectRepositoryContext,
  ): Promise<AssistantProjectToolOutput> => {
    let result: AssistantProjectListResult | AssistantProjectContextResult;

    try {
      const repository = createRepository(context);
      result = call.name === 'list_projects'
        ? await listProjects(repository, (call.arguments as { includeArchived: boolean }).includeArchived)
        : await getProjectContext(
            repository,
            (call.arguments as { projectId: string }).projectId,
            (call.arguments as { focus: AssistantProjectContextFocus }).focus,
          );
    } catch (error) {
      console.error('Project assistant tool failed.', error);
      result = errorResult();
    }

    return {
      callId: call.callId,
      execution: 'server',
      name: call.name,
      result,
    };
  };
}

export const executeAssistantProjectTool = createAssistantProjectToolExecutor();
