import {
  acceptProjectKnowledge,
  closeProjectWorkSession,
  completeProjectTask,
  markDecisionSuperseded,
  markKnowledgeSuperseded,
  ProjectDomainError,
} from '../../domain/projects';
import type {
  CreateDecisionReplacement,
  CreateKnowledgeReplacement,
  ISODateTime,
  MeaningfulProjectOperation,
  Project,
  ProjectChangeEvent,
  ProjectDecision,
  ProjectDeliverable,
  ProjectKnowledgeItem,
  ProjectKnowledgeKind,
  ProjectMilestone,
  ProjectPriority,
  ProjectSection,
  ProjectStatus,
  ProjectTask,
  ProjectTaskStatus,
  ProjectWorkSession,
  ProjectWorkSessionEntry,
} from '../../domain/projects';

import type { ProjectRepository } from './project-repository';

type ProjectServiceOptions = {
  createId?: () => string;
  now?: () => Date;
};

type SupersededValue<T> = {
  previous: T;
  replacement: T;
};

type ClosedWorkSessionValue = {
  entries: ProjectWorkSessionEntry[];
  session: ProjectWorkSession;
};

export type ProjectWriteResult<T> = {
  outcome: 'created' | 'unchanged' | 'updated';
  value: T;
};

export type CreateProjectInput = {
  description?: string;
  goal?: string;
  name: string;
  priority?: ProjectPriority;
  startDate?: string;
  status?: ProjectStatus;
  targetDate?: string;
  timezone: string;
  type?: Project['type'];
};

export type UpdateProjectInput = Partial<Pick<
  Project,
  'description' | 'goal' | 'name' | 'priority' | 'startDate' | 'status' |
  'targetDate' | 'type'
>>;

export type CreateTaskInput = {
  description?: string;
  dueDate?: string;
  priority?: ProjectPriority;
  status?: Exclude<ProjectTaskStatus, 'completed'>;
  title: string;
};

export type UpdateTaskInput = Partial<Pick<
  ProjectTask,
  'description' | 'dueDate' | 'priority' | 'status' | 'title'
>>;

export type CreateMilestoneInput = {
  description?: string;
  name: string;
  status?: ProjectMilestone['status'];
  targetDate?: string;
};

export type UpdateMilestoneInput = Partial<Pick<
  ProjectMilestone,
  'description' | 'name' | 'status' | 'targetDate'
>>;

export type CreateDeliverableInput = {
  description?: string;
  dueDate?: string;
  milestoneId?: string;
  name: string;
  status?: ProjectDeliverable['status'];
};

export type UpdateDeliverableInput = Partial<Pick<
  ProjectDeliverable,
  'description' | 'dueDate' | 'milestoneId' | 'name' | 'status'
>>;

export const PROJECT_SECTION_TITLE_MAX_LENGTH = 48;

export function projectOverviewSectionId(projectId: string) {
  return `project-section-overview:${projectId}`;
}

export type CreateKnowledgeInput = {
  content: string;
  kind: ProjectKnowledgeKind;
  title?: string;
};

export type CreateDecisionInput = {
  rationale?: string;
  statement: string;
};

let fallbackIdSequence = 1;

function defaultCreateId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `project-entity-${Date.now()}-${fallbackIdSequence++}`;
}

function requireNonEmpty(value: string, label: string) {
  const normalized = value.trim();

  if (!normalized) {
    throw new ProjectDomainError('invalid_value', `${label} cannot be empty.`);
  }

  return normalized;
}

function optionalText(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizedIdentity(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function requireSectionTitle(value: string) {
  const title = value.trim().replace(/\s+/g, ' ');
  if (!title) {
    throw new ProjectDomainError('invalid_value', 'Section title cannot be empty.');
  }
  if (title.length > PROJECT_SECTION_TITLE_MAX_LENGTH) {
    throw new ProjectDomainError(
      'invalid_value',
      `Section title cannot exceed ${PROJECT_SECTION_TITLE_MAX_LENGTH} characters.`,
    );
  }
  return title;
}

function requireDate(value: string | undefined, label: string) {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ProjectDomainError('invalid_value', `${label} must be an ISO date.`);
  }
  return value;
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class ProjectService {
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly repository: ProjectRepository;

  constructor(repository: ProjectRepository, options: ProjectServiceOptions = {}) {
    this.repository = repository;
    this.createId = options.createId ?? defaultCreateId;
    this.now = options.now ?? (() => new Date());
  }

  async createProject(input: CreateProjectInput): Promise<ProjectWriteResult<Project>> {
    const name = requireNonEmpty(input.name, 'Project name');
    const timezone = requireNonEmpty(input.timezone, 'Project timezone');
    const duplicate = (await this.repository.listProjects()).find(
      (project) => normalizedIdentity(project.name) === normalizedIdentity(name) &&
        project.status !== 'archived' && project.status !== 'cancelled',
    );
    if (duplicate) {
      await this.ensureOverviewSection(duplicate.id);
      return { outcome: 'unchanged', value: duplicate };
    }

    const occurredAt = this.currentTime();
    const project: Project = {
      createdAt: occurredAt,
      ...optionalText(input.description) ? { description: optionalText(input.description) } : {},
      ...optionalText(input.goal) ? { goal: optionalText(input.goal) } : {},
      id: this.createId(),
      name,
      priority: input.priority ?? 'normal',
      ...input.startDate ? { startDate: requireDate(input.startDate, 'Project start date') } : {},
      status: input.status ?? 'planned',
      ...input.targetDate ? { targetDate: requireDate(input.targetDate, 'Project target date') } : {},
      timezone,
      type: input.type ?? 'general',
      updatedAt: occurredAt,
    } as Project;
    await this.repository.saveAtomically({
      projects: [project],
      sections: [this.createOverviewSection(project.id, occurredAt)],
    });
    return { outcome: 'created', value: project };
  }

  async ensureOverviewSection(projectId: string) {
    await this.requireProject(projectId);
    const existing = (await this.repository.listSections(projectId)).find(
      (section) => section.isDefault,
    );
    if (existing) return existing;

    const overview = this.createOverviewSection(projectId, this.currentTime());
    await this.repository.saveSection(overview);
    return overview;
  }

  async listSections(projectId: string) {
    await this.ensureOverviewSection(projectId);
    return this.repository.listSections(projectId);
  }

  async addSection(
    projectId: string,
    titleInput: string,
  ): Promise<ProjectWriteResult<ProjectSection>> {
    await this.requireProject(projectId);
    const title = requireSectionTitle(titleInput);
    const sections = await this.repository.listSections(projectId);
    this.rejectDuplicateActiveSectionTitle(sections, title);
    const occurredAt = this.currentTime();
    const section: ProjectSection = {
      createdAt: occurredAt,
      id: this.createId(),
      isDefault: false,
      position: sections
        .filter((value) => value.status === 'active')
        .reduce((maximum, value) => Math.max(maximum, value.position), -1) + 1,
      projectId,
      status: 'active',
      title,
      updatedAt: occurredAt,
    };
    await this.repository.saveSection(section);
    return { outcome: 'created', value: section };
  }

  async renameSection(
    projectId: string,
    sectionId: string,
    titleInput: string,
  ): Promise<ProjectWriteResult<ProjectSection>> {
    const section = await this.requireSection(sectionId);
    this.requireProjectMatch(projectId, section.projectId);
    const title = requireSectionTitle(titleInput);
    if (section.isDefault && title !== 'Overview') {
      throw new ProjectDomainError('invalid_transition', 'Overview cannot be renamed.');
    }
    if (section.title === title) return { outcome: 'unchanged', value: section };
    const sections = await this.repository.listSections(projectId);
    this.rejectDuplicateActiveSectionTitle(sections, title, section.id);
    const updated = { ...section, title, updatedAt: this.currentTime() };
    await this.repository.saveSection(updated);
    return { outcome: 'updated', value: updated };
  }

  async reorderSections(projectId: string, orderedSectionIds: readonly string[]) {
    await this.requireProject(projectId);
    const active = (await this.repository.listSections(projectId)).filter(
      (section) => section.status === 'active',
    );
    const supplied = new Set(orderedSectionIds);
    if (
      supplied.size !== orderedSectionIds.length ||
      orderedSectionIds.length !== active.length ||
      active.some((section) => !supplied.has(section.id))
    ) {
      throw new ProjectDomainError(
        'project_mismatch',
        'Section order must contain every active section in this Project exactly once.',
      );
    }
    const overview = active.find((section) => section.isDefault);
    if (!overview || orderedSectionIds[0] !== overview.id) {
      throw new ProjectDomainError('invalid_transition', 'Overview must remain first.');
    }
    if (active.every((section, index) => section.id === orderedSectionIds[index])) {
      return active;
    }
    return this.repository.reorderSections(
      projectId,
      orderedSectionIds,
      this.currentTime(),
    );
  }

  async archiveSection(
    projectId: string,
    sectionId: string,
  ): Promise<ProjectWriteResult<ProjectSection>> {
    const section = await this.requireSection(sectionId);
    this.requireProjectMatch(projectId, section.projectId);
    if (section.isDefault) {
      throw new ProjectDomainError('invalid_transition', 'Overview cannot be archived.');
    }
    if (section.status === 'archived') return { outcome: 'unchanged', value: section };
    const updated: ProjectSection = {
      ...section,
      status: 'archived',
      updatedAt: this.currentTime(),
    };
    await this.repository.saveSection(updated);
    return { outcome: 'updated', value: updated };
  }

  async restoreSection(
    projectId: string,
    sectionId: string,
  ): Promise<ProjectWriteResult<ProjectSection>> {
    const section = await this.requireSection(sectionId);
    this.requireProjectMatch(projectId, section.projectId);
    if (section.status === 'active') return { outcome: 'unchanged', value: section };
    const sections = await this.repository.listSections(projectId);
    this.rejectDuplicateActiveSectionTitle(sections, section.title, section.id);
    const updated: ProjectSection = {
      ...section,
      position: sections
        .filter((value) => value.status === 'active')
        .reduce((maximum, value) => Math.max(maximum, value.position), -1) + 1,
      status: 'active',
      updatedAt: this.currentTime(),
    };
    await this.repository.saveSection(updated);
    return { outcome: 'updated', value: updated };
  }

  async updateProject(
    projectId: string,
    input: UpdateProjectInput,
  ): Promise<ProjectWriteResult<Project>> {
    const current = await this.requireProject(projectId);
    const updated: Project = {
      ...current,
      ...(input.name !== undefined ? { name: requireNonEmpty(input.name, 'Project name') } : {}),
      ...(input.description !== undefined ? { description: requireNonEmpty(input.description, 'Project description') } : {}),
      ...(input.goal !== undefined ? { goal: requireNonEmpty(input.goal, 'Project goal') } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.startDate !== undefined ? { startDate: requireDate(input.startDate, 'Project start date') } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.targetDate !== undefined ? { targetDate: requireDate(input.targetDate, 'Project target date') } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
    };
    if (sameValue(current, updated)) return { outcome: 'unchanged', value: current };
    updated.updatedAt = this.currentTime();
    await this.repository.saveProject(updated);
    return { outcome: 'updated', value: updated };
  }

  async createTask(projectId: string, input: CreateTaskInput): Promise<ProjectWriteResult<ProjectTask>> {
    await this.requireProject(projectId);
    const title = requireNonEmpty(input.title, 'Task title');
    const tasks = await this.repository.listTasks(projectId);
    const duplicate = tasks.find((task) =>
      normalizedIdentity(task.title) === normalizedIdentity(title) && task.status !== 'cancelled');
    if (duplicate) return { outcome: 'unchanged', value: duplicate };
    const occurredAt = this.currentTime();
    const task: ProjectTask = {
      createdAt: occurredAt,
      ...optionalText(input.description) ? { description: optionalText(input.description) } : {},
      ...input.dueDate ? { dueDate: requireDate(input.dueDate, 'Task due date') } : {},
      id: this.createId(),
      position: tasks.reduce((maximum, value) => Math.max(maximum, value.position), -1) + 1,
      priority: input.priority ?? 'normal', projectId, status: input.status ?? 'todo', title,
      updatedAt: occurredAt,
    } as ProjectTask;
    await this.repository.saveTask(task);
    return { outcome: 'created', value: task };
  }

  async updateTask(projectId: string, taskId: string, input: UpdateTaskInput): Promise<ProjectWriteResult<ProjectTask>> {
    const current = await this.requireTask(taskId);
    this.requireProjectMatch(projectId, current.projectId);
    if (input.status === 'completed') {
      const operation = await this.completeTask(taskId);
      return { outcome: 'updated', value: operation.value };
    }
    const updated: ProjectTask = { ...current,
      ...(input.title !== undefined ? { title: requireNonEmpty(input.title, 'Task title') } : {}),
      ...(input.description !== undefined ? { description: requireNonEmpty(input.description, 'Task description') } : {}),
      ...(input.dueDate !== undefined ? { dueDate: requireDate(input.dueDate, 'Task due date') } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    };
    if (sameValue(current, updated)) return { outcome: 'unchanged', value: current };
    updated.updatedAt = this.currentTime();
    await this.repository.saveTask(updated);
    return { outcome: 'updated', value: updated };
  }

  async createMilestone(projectId: string, input: CreateMilestoneInput): Promise<ProjectWriteResult<ProjectMilestone>> {
    await this.requireProject(projectId);
    const name = requireNonEmpty(input.name, 'Milestone name');
    const values = await this.repository.listMilestones(projectId);
    const duplicate = values.find((value) => normalizedIdentity(value.name) === normalizedIdentity(name) && value.status !== 'cancelled');
    if (duplicate) return { outcome: 'unchanged', value: duplicate };
    const occurredAt = this.currentTime();
    const value: ProjectMilestone = { createdAt: occurredAt,
      ...optionalText(input.description) ? { description: optionalText(input.description) } : {},
      id: this.createId(), name, position: values.reduce((max, item) => Math.max(max, item.position), -1) + 1,
      projectId, status: input.status ?? 'planned',
      ...input.targetDate ? { targetDate: requireDate(input.targetDate, 'Milestone target date') } : {},
      updatedAt: occurredAt } as ProjectMilestone;
    await this.repository.saveMilestone(value);
    return { outcome: 'created', value };
  }

  async updateMilestone(projectId: string, id: string, input: UpdateMilestoneInput): Promise<ProjectWriteResult<ProjectMilestone>> {
    const current = await this.requireMilestone(id); this.requireProjectMatch(projectId, current.projectId);
    const updated: ProjectMilestone = { ...current,
      ...(input.name !== undefined ? { name: requireNonEmpty(input.name, 'Milestone name') } : {}),
      ...(input.description !== undefined ? { description: requireNonEmpty(input.description, 'Milestone description') } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.targetDate !== undefined ? { targetDate: requireDate(input.targetDate, 'Milestone target date') } : {}),
    };
    if (sameValue(current, updated)) return { outcome: 'unchanged', value: current };
    updated.updatedAt = this.currentTime(); await this.repository.saveMilestone(updated);
    return { outcome: 'updated', value: updated };
  }

  async createDeliverable(projectId: string, input: CreateDeliverableInput): Promise<ProjectWriteResult<ProjectDeliverable>> {
    await this.requireProject(projectId);
    if (input.milestoneId) { const milestone = await this.requireMilestone(input.milestoneId); this.requireProjectMatch(projectId, milestone.projectId); }
    const name = requireNonEmpty(input.name, 'Deliverable name');
    const values = await this.repository.listDeliverables(projectId);
    const duplicate = values.find((value) => normalizedIdentity(value.name) === normalizedIdentity(name) && value.status !== 'cancelled');
    if (duplicate) return { outcome: 'unchanged', value: duplicate };
    const occurredAt = this.currentTime();
    const value: ProjectDeliverable = { createdAt: occurredAt,
      ...optionalText(input.description) ? { description: optionalText(input.description) } : {},
      ...input.dueDate ? { dueDate: requireDate(input.dueDate, 'Deliverable due date') } : {},
      id: this.createId(), ...input.milestoneId ? { milestoneId: input.milestoneId } : {}, name,
      position: values.reduce((max, item) => Math.max(max, item.position), -1) + 1,
      projectId, status: input.status ?? 'planned', updatedAt: occurredAt } as ProjectDeliverable;
    await this.repository.saveDeliverable(value);
    return { outcome: 'created', value };
  }

  async updateDeliverable(projectId: string, id: string, input: UpdateDeliverableInput): Promise<ProjectWriteResult<ProjectDeliverable>> {
    const current = await this.requireDeliverable(id); this.requireProjectMatch(projectId, current.projectId);
    if (input.milestoneId) { const milestone = await this.requireMilestone(input.milestoneId); this.requireProjectMatch(projectId, milestone.projectId); }
    const updated: ProjectDeliverable = { ...current,
      ...(input.name !== undefined ? { name: requireNonEmpty(input.name, 'Deliverable name') } : {}),
      ...(input.description !== undefined ? { description: requireNonEmpty(input.description, 'Deliverable description') } : {}),
      ...(input.dueDate !== undefined ? { dueDate: requireDate(input.dueDate, 'Deliverable due date') } : {}),
      ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    };
    if (sameValue(current, updated)) return { outcome: 'unchanged', value: current };
    updated.updatedAt = this.currentTime(); await this.repository.saveDeliverable(updated);
    return { outcome: 'updated', value: updated };
  }

  async addCurrentKnowledge(projectId: string, input: CreateKnowledgeInput): Promise<ProjectWriteResult<ProjectKnowledgeItem>> {
    await this.requireProject(projectId);
    const content = requireNonEmpty(input.content, 'Knowledge content');
    const current = await this.repository.listKnowledgeItems(projectId);
    const duplicate = current.find((item) => item.status === 'current' && item.kind === input.kind && normalizedIdentity(item.content) === normalizedIdentity(content));
    if (duplicate) return { outcome: 'unchanged', value: duplicate };
    const occurredAt = this.currentTime();
    const value: ProjectKnowledgeItem = { content, createdAt: occurredAt, id: this.createId(), kind: input.kind,
      projectId, status: 'current', ...optionalText(input.title) ? { title: optionalText(input.title) } : {}, updatedAt: occurredAt } as ProjectKnowledgeItem;
    const changeEvent = this.createChangeEvent({ after: { status: 'current' }, entityId: value.id,
      entityType: 'knowledge', eventType: 'knowledge_accepted', occurredAt, projectId,
      summary: `Accepted project knowledge: ${value.title ?? value.content}` });
    await this.repository.saveAtomically({ changeEvents: [changeEvent], knowledgeItems: [value] });
    return { outcome: 'created', value };
  }

  async addDecision(projectId: string, input: CreateDecisionInput): Promise<ProjectWriteResult<ProjectDecision>> {
    await this.requireProject(projectId);
    const statement = requireNonEmpty(input.statement, 'Decision statement');
    const duplicate = (await this.repository.listDecisions(projectId)).find((decision) => decision.status === 'active' && normalizedIdentity(decision.statement) === normalizedIdentity(statement));
    if (duplicate) return { outcome: 'unchanged', value: duplicate };
    const occurredAt = this.currentTime();
    const value: ProjectDecision = { createdAt: occurredAt, decidedAt: occurredAt, id: this.createId(), projectId,
      ...optionalText(input.rationale) ? { rationale: optionalText(input.rationale) } : {}, statement, status: 'active', updatedAt: occurredAt } as ProjectDecision;
    await this.repository.saveDecision(value);
    return { outcome: 'created', value };
  }

  async replaceKnowledge(
    projectId: string,
    knowledgeItemId: string,
    input: CreateKnowledgeReplacement,
  ): Promise<ProjectWriteResult<ProjectKnowledgeItem>> {
    const current = await this.requireKnowledgeItem(knowledgeItemId);
    this.requireProjectMatch(projectId, current.projectId);
    if (normalizedIdentity(current.content) === normalizedIdentity(input.content) && current.kind === input.kind) {
      return { outcome: 'unchanged', value: current };
    }
    const operation = await this.supersedeKnowledge(knowledgeItemId, input);
    return { outcome: 'updated', value: operation.value.replacement };
  }

  async replaceDecision(
    projectId: string,
    decisionId: string,
    input: CreateDecisionReplacement,
  ): Promise<ProjectWriteResult<ProjectDecision>> {
    const current = await this.requireDecision(decisionId);
    this.requireProjectMatch(projectId, current.projectId);
    if (normalizedIdentity(current.statement) === normalizedIdentity(input.statement)) {
      return { outcome: 'unchanged', value: current };
    }
    const operation = await this.supersedeDecision(decisionId, input);
    return { outcome: 'updated', value: operation.value.replacement };
  }

  async acceptProposedKnowledge(
    knowledgeItemId: string,
  ): Promise<MeaningfulProjectOperation<ProjectKnowledgeItem>> {
    const item = await this.requireKnowledgeItem(knowledgeItemId);
    const occurredAt = this.currentTime();
    const accepted = acceptProjectKnowledge(item, occurredAt);
    const changeEvent = this.createChangeEvent({
      after: { status: accepted.status },
      before: { status: item.status },
      entityId: accepted.id,
      entityType: 'knowledge',
      eventType: 'knowledge_accepted',
      occurredAt,
      projectId: accepted.projectId,
      sourceSessionId: accepted.sourceSessionId,
      summary: `Accepted project knowledge: ${accepted.title ?? accepted.content}`,
    });

    await this.repository.saveAtomically({
      changeEvents: [changeEvent],
      knowledgeItems: [accepted],
    });

    return { changeEvent, value: accepted };
  }

  async closeWorkSession(
    sessionId: string,
    summary: string,
    endedAt = this.currentTime(),
  ): Promise<MeaningfulProjectOperation<ClosedWorkSessionValue>> {
    const session = await this.requireWorkSession(sessionId);
    const closed = closeProjectWorkSession(session, summary, endedAt);
    const entries = await this.repository.listWorkSessionEntries(sessionId);
    const changeEvent = this.createChangeEvent({
      after: { endedAt: closed.endedAt, summary: closed.summary },
      before: { endedAt: session.endedAt, summary: session.summary },
      entityId: closed.id,
      entityType: 'work_session',
      eventType: 'work_session_closed',
      occurredAt: endedAt,
      projectId: closed.projectId,
      sourceSessionId: closed.id,
      summary: `Closed work session${closed.title ? ` “${closed.title}”` : ''}.`,
    });

    await this.repository.saveAtomically({
      changeEvents: [changeEvent],
      workSessions: [closed],
    });

    return { changeEvent, value: { entries, session: closed } };
  }

  async completeTask(
    taskId: string,
  ): Promise<MeaningfulProjectOperation<ProjectTask>> {
    const task = await this.requireTask(taskId);
    const occurredAt = this.currentTime();
    const completed = completeProjectTask(task, occurredAt);
    const changeEvent = this.createChangeEvent({
      after: { completedAt: completed.completedAt, status: completed.status },
      before: { completedAt: task.completedAt, status: task.status },
      entityId: completed.id,
      entityType: 'task',
      eventType: 'task_completed',
      occurredAt,
      projectId: completed.projectId,
      sourceSessionId: completed.sourceSessionId,
      summary: `Completed task: ${completed.title}`,
    });

    await this.repository.saveAtomically({
      changeEvents: [changeEvent],
      tasks: [completed],
    });

    return { changeEvent, value: completed };
  }

  async supersedeDecision(
    decisionId: string,
    replacementInput: CreateDecisionReplacement,
  ): Promise<MeaningfulProjectOperation<SupersededValue<ProjectDecision>>> {
    const previous = await this.requireDecision(decisionId);
    const occurredAt = this.currentTime();
    const superseded = markDecisionSuperseded(previous, occurredAt);
    const replacement: ProjectDecision = {
      createdAt: occurredAt,
      decidedAt: replacementInput.decidedAt ?? occurredAt,
      id: replacementInput.id ?? this.createId(),
      projectId: previous.projectId,
      ...(replacementInput.rationale?.trim()
        ? { rationale: replacementInput.rationale.trim() }
        : {}),
      ...(replacementInput.sourceSessionId
        ? { sourceSessionId: replacementInput.sourceSessionId }
        : {}),
      statement: requireNonEmpty(replacementInput.statement, 'Decision statement'),
      status: 'active',
      supersedesDecisionId: previous.id,
      updatedAt: occurredAt,
    };
    const changeEvent = this.createChangeEvent({
      after: { decisionId: replacement.id, statement: replacement.statement },
      before: { decisionId: previous.id, statement: previous.statement },
      entityId: replacement.id,
      entityType: 'decision',
      eventType: 'decision_superseded',
      occurredAt,
      projectId: replacement.projectId,
      sourceSessionId: replacement.sourceSessionId,
      summary: `Replaced decision “${previous.statement}” with “${replacement.statement}”.`,
    });

    await this.repository.saveAtomically({
      changeEvents: [changeEvent],
      decisions: [superseded, replacement],
    });

    return {
      changeEvent,
      value: { previous: superseded, replacement },
    };
  }

  async supersedeKnowledge(
    knowledgeItemId: string,
    replacementInput: CreateKnowledgeReplacement,
  ): Promise<MeaningfulProjectOperation<SupersededValue<ProjectKnowledgeItem>>> {
    const previous = await this.requireKnowledgeItem(knowledgeItemId);
    const occurredAt = this.currentTime();
    const superseded = markKnowledgeSuperseded(previous, occurredAt);
    const replacement: ProjectKnowledgeItem = {
      content: requireNonEmpty(replacementInput.content, 'Knowledge content'),
      createdAt: occurredAt,
      id: replacementInput.id ?? this.createId(),
      kind: replacementInput.kind,
      projectId: previous.projectId,
      ...(replacementInput.sourceSessionId
        ? { sourceSessionId: replacementInput.sourceSessionId }
        : {}),
      status: 'current',
      supersedesKnowledgeItemId: previous.id,
      ...(replacementInput.title?.trim()
        ? { title: replacementInput.title.trim() }
        : {}),
      updatedAt: occurredAt,
    };
    const changeEvent = this.createChangeEvent({
      after: { knowledgeItemId: replacement.id, kind: replacement.kind },
      before: { knowledgeItemId: previous.id, kind: previous.kind },
      entityId: replacement.id,
      entityType: 'knowledge',
      eventType: 'knowledge_superseded',
      occurredAt,
      projectId: replacement.projectId,
      sourceSessionId: replacement.sourceSessionId,
      summary: `Replaced project knowledge: ${previous.title ?? previous.content}`,
    });

    await this.repository.saveAtomically({
      changeEvents: [changeEvent],
      knowledgeItems: [superseded, replacement],
    });

    return {
      changeEvent,
      value: { previous: superseded, replacement },
    };
  }

  private createChangeEvent(
    input: Omit<ProjectChangeEvent, 'id'>,
  ): ProjectChangeEvent {
    return { ...input, id: this.createId() };
  }

  private currentTime(): ISODateTime {
    return this.now().toISOString();
  }

  private async requireDecision(id: string) {
    const decision = await this.repository.getDecision(id);

    if (!decision) {
      throw new ProjectDomainError('not_found', 'Project decision was not found.');
    }

    return decision;
  }

  private async requireDeliverable(id: string) {
    const value = await this.repository.getDeliverable(id);
    if (!value) throw new ProjectDomainError('not_found', 'Project deliverable was not found.');
    return value;
  }

  private async requireKnowledgeItem(id: string) {
    const item = await this.repository.getKnowledgeItem(id);

    if (!item) {
      throw new ProjectDomainError('not_found', 'Project knowledge was not found.');
    }

    return item;
  }

  private async requireMilestone(id: string) {
    const value = await this.repository.getMilestone(id);
    if (!value) throw new ProjectDomainError('not_found', 'Project milestone was not found.');
    return value;
  }

  private async requireProject(id: string) {
    const value = await this.repository.getProject(id);
    if (!value) throw new ProjectDomainError('not_found', 'Project was not found.');
    return value;
  }

  private createOverviewSection(projectId: string, occurredAt: string): ProjectSection {
    return {
      createdAt: occurredAt,
      id: projectOverviewSectionId(projectId),
      isDefault: true,
      position: 0,
      projectId,
      status: 'active',
      title: 'Overview',
      updatedAt: occurredAt,
    };
  }

  private rejectDuplicateActiveSectionTitle(
    sections: readonly ProjectSection[],
    title: string,
    excludingId?: string,
  ) {
    if (sections.some((section) =>
      section.id !== excludingId && section.status === 'active' &&
      normalizedIdentity(section.title) === normalizedIdentity(title))) {
      throw new ProjectDomainError(
        'invalid_value',
        'An active section with that title already exists in this Project.',
      );
    }
  }

  private requireProjectMatch(expected: string, actual: string) {
    if (expected !== actual) {
      throw new ProjectDomainError('project_mismatch', 'The Project entity does not belong to that Project.');
    }
  }

  private async requireTask(id: string) {
    const task = await this.repository.getTask(id);

    if (!task) {
      throw new ProjectDomainError('not_found', 'Project task was not found.');
    }

    return task;
  }

  private async requireSection(id: string) {
    const section = await this.repository.getSection(id);
    if (!section) {
      throw new ProjectDomainError('not_found', 'Project section was not found.');
    }
    return section;
  }

  private async requireWorkSession(id: string) {
    const session = await this.repository.getWorkSession(id);

    if (!session) {
      throw new ProjectDomainError('not_found', 'Project work session was not found.');
    }

    return session;
  }
}
