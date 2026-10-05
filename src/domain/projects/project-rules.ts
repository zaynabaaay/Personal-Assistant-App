import type {
  ISODateTime,
  ProjectDecision,
  ProjectKnowledgeItem,
  ProjectTask,
  ProjectWorkSession,
} from './project-types';

export type ProjectDomainErrorCode =
  | 'invalid_transition'
  | 'invalid_value'
  | 'not_found'
  | 'project_mismatch';

export class ProjectDomainError extends Error {
  readonly code: ProjectDomainErrorCode;

  constructor(code: ProjectDomainErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ProjectDomainError';
  }
}

export function completeProjectTask(task: ProjectTask, completedAt: ISODateTime) {
  if (task.status === 'completed' || task.status === 'cancelled') {
    throw new ProjectDomainError(
      'invalid_transition',
      `A ${task.status} task cannot be completed.`,
    );
  }

  return {
    ...task,
    completedAt,
    status: 'completed',
    updatedAt: completedAt,
  } satisfies ProjectTask;
}

export function acceptProjectKnowledge(
  item: ProjectKnowledgeItem,
  acceptedAt: ISODateTime,
) {
  if (item.status !== 'proposed') {
    throw new ProjectDomainError(
      'invalid_transition',
      'Only proposed project knowledge can be accepted.',
    );
  }

  return {
    ...item,
    status: 'current',
    updatedAt: acceptedAt,
  } satisfies ProjectKnowledgeItem;
}

export function markKnowledgeSuperseded(
  item: ProjectKnowledgeItem,
  supersededAt: ISODateTime,
) {
  if (item.status !== 'current') {
    throw new ProjectDomainError(
      'invalid_transition',
      'Only current project knowledge can be superseded.',
    );
  }

  return {
    ...item,
    status: 'superseded',
    updatedAt: supersededAt,
  } satisfies ProjectKnowledgeItem;
}

export function markDecisionSuperseded(
  decision: ProjectDecision,
  supersededAt: ISODateTime,
) {
  if (decision.status !== 'active') {
    throw new ProjectDomainError(
      'invalid_transition',
      'Only an active decision can be superseded.',
    );
  }

  return {
    ...decision,
    status: 'superseded',
    updatedAt: supersededAt,
  } satisfies ProjectDecision;
}

export function closeProjectWorkSession(
  session: ProjectWorkSession,
  summary: string,
  endedAt: ISODateTime,
) {
  const normalizedSummary = summary.trim();
  const endedAtTime = new Date(endedAt).getTime();
  const startedAtTime = new Date(session.startedAt).getTime();

  if (session.endedAt) {
    throw new ProjectDomainError(
      'invalid_transition',
      'The work session is already closed.',
    );
  }

  if (!normalizedSummary) {
    throw new ProjectDomainError(
      'invalid_value',
      'A closed work session requires a summary.',
    );
  }

  if (
    !Number.isFinite(endedAtTime) ||
    !Number.isFinite(startedAtTime) ||
    endedAtTime < startedAtTime
  ) {
    throw new ProjectDomainError(
      'invalid_value',
      'A work session cannot end before it starts.',
    );
  }

  return {
    ...session,
    endedAt,
    summary: normalizedSummary,
    updatedAt: endedAt,
  } satisfies ProjectWorkSession;
}
