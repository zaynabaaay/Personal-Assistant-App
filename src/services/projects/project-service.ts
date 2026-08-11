import {
  acceptProjectKnowledge,
  closeProjectWorkSession,
  completeProjectTask,
  markDecisionSuperseded,
  markKnowledgeSuperseded,
  ProjectDomainError,
} from '@/domain/projects';
import type {
  CreateDecisionReplacement,
  CreateKnowledgeReplacement,
  ISODateTime,
  MeaningfulProjectOperation,
  ProjectChangeEvent,
  ProjectDecision,
  ProjectKnowledgeItem,
  ProjectTask,
  ProjectWorkSession,
  ProjectWorkSessionEntry,
} from '@/domain/projects';

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

export class ProjectService {
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly repository: ProjectRepository;

  constructor(repository: ProjectRepository, options: ProjectServiceOptions = {}) {
    this.repository = repository;
    this.createId = options.createId ?? defaultCreateId;
    this.now = options.now ?? (() => new Date());
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

    await this.repository.saveKnowledgeItem(accepted);
    await this.repository.addChangeEvent(changeEvent);

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

    await this.repository.saveWorkSession(closed);
    await this.repository.addChangeEvent(changeEvent);

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

    await this.repository.saveTask(completed);
    await this.repository.addChangeEvent(changeEvent);

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

    await this.repository.saveDecision(superseded);
    await this.repository.saveDecision(replacement);
    await this.repository.addChangeEvent(changeEvent);

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

    await this.repository.saveKnowledgeItem(superseded);
    await this.repository.saveKnowledgeItem(replacement);
    await this.repository.addChangeEvent(changeEvent);

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

  private async requireKnowledgeItem(id: string) {
    const item = await this.repository.getKnowledgeItem(id);

    if (!item) {
      throw new ProjectDomainError('not_found', 'Project knowledge was not found.');
    }

    return item;
  }

  private async requireTask(id: string) {
    const task = await this.repository.getTask(id);

    if (!task) {
      throw new ProjectDomainError('not_found', 'Project task was not found.');
    }

    return task;
  }

  private async requireWorkSession(id: string) {
    const session = await this.repository.getWorkSession(id);

    if (!session) {
      throw new ProjectDomainError('not_found', 'Project work session was not found.');
    }

    return session;
  }
}

