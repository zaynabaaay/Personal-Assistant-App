import type {
  ProjectChangeEventType,
  ProjectKnowledgeKind,
  ProjectPriority,
  ProjectStatus,
  ProjectTaskStatus,
} from '@/domain/projects';

import type {
  AssistantToolCall,
  AssistantToolContract,
  AssistantToolOutput,
} from './tool-contract';

export const ASSISTANT_PROJECT_TOOL_NAMES = [
  'list_projects',
  'get_project_context',
] as const;

export type AssistantProjectToolName =
  (typeof ASSISTANT_PROJECT_TOOL_NAMES)[number];
export type AssistantProjectContextFocus =
  | 'overview'
  | 'work'
  | 'knowledge'
  | 'history'
  | 'comprehensive';

export type ListProjectsArguments = { includeArchived: boolean };
export type GetProjectContextArguments = {
  focus: AssistantProjectContextFocus;
  projectId: string;
};
export type AssistantProjectToolArguments =
  | ListProjectsArguments
  | GetProjectContextArguments;

export type AssistantProjectSummary = {
  completedAt?: string;
  description?: string;
  goal?: string;
  id: string;
  name: string;
  priority: ProjectPriority;
  startDate?: string;
  status: ProjectStatus;
  targetDate?: string;
  timezone: string;
  type: string;
  updatedAt: string;
};

export type AssistantProjectTask = {
  deliverableId?: string;
  description?: string;
  dueDate?: string;
  id: string;
  milestoneId?: string;
  position: number;
  priority: ProjectPriority;
  scheduledFor?: string;
  status: ProjectTaskStatus;
  title: string;
};

export type AssistantProjectMilestone = {
  description?: string;
  id: string;
  name: string;
  position: number;
  status: string;
  targetDate?: string;
};

export type AssistantProjectDeliverable = AssistantProjectMilestone & {
  dueDate?: string;
  milestoneId?: string;
};

export type AssistantProjectKnowledge = {
  content: string;
  id: string;
  kind: ProjectKnowledgeKind;
  title?: string;
  updatedAt: string;
};

export type AssistantProjectDecision = {
  decidedAt: string;
  id: string;
  rationale?: string;
  statement: string;
};

export type AssistantProjectWorkSession = {
  endedAt?: string;
  id: string;
  startedAt: string;
  summary?: string;
  title?: string;
};

export type AssistantProjectResource = {
  description?: string;
  externalUrl?: string;
  id: string;
  mimeType?: string;
  name: string;
  role: string;
  type: string;
};

export type AssistantProjectChange = {
  entityType: string;
  eventType: ProjectChangeEventType;
  id: string;
  occurredAt: string;
  summary: string;
};

export type AssistantProjectListResult =
  | {
      projects: AssistantProjectSummary[];
      status: 'success';
      truncated: boolean;
    }
  | { message: string; status: 'error' };

export type AssistantProjectContextResult =
  | {
      currentDecisions?: AssistantProjectDecision[];
      currentKnowledge?: AssistantProjectKnowledge[];
      deliverables?: AssistantProjectDeliverable[];
      focus: AssistantProjectContextFocus;
      milestones?: AssistantProjectMilestone[];
      openTasks?: AssistantProjectTask[];
      project: AssistantProjectSummary;
      recentChanges?: AssistantProjectChange[];
      recentWorkSessions?: AssistantProjectWorkSession[];
      resources?: AssistantProjectResource[];
      status: 'success';
      truncatedSections: string[];
      unresolvedQuestions?: AssistantProjectKnowledge[];
    }
  | { message: string; status: 'error' | 'not_found' };

export type AssistantProjectToolResult =
  | AssistantProjectListResult
  | AssistantProjectContextResult;
export type AssistantProjectToolCall = AssistantToolCall<
  AssistantProjectToolName,
  'server',
  AssistantProjectToolArguments
>;
export type AssistantProjectToolOutput = AssistantToolOutput<
  AssistantProjectToolName,
  'server',
  AssistantProjectToolResult
>;

const FOCUSES: readonly AssistantProjectContextFocus[] = [
  'overview', 'work', 'knowledge', 'history', 'comprehensive',
];
const MAX_RESULT_CHARACTERS = 48_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, max = 2_000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isFocus(value: unknown): value is AssistantProjectContextFocus {
  return typeof value === 'string' && FOCUSES.includes(value as AssistantProjectContextFocus);
}

function isBoundedJson(value: unknown) {
  try {
    return JSON.stringify(value).length <= MAX_RESULT_CHARACTERS;
  } catch {
    return false;
  }
}

function isOptionalString(value: unknown, max = 2_000) {
  return value === undefined || isBoundedString(value, max);
}

function isStringRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): value is Record<string, unknown> {
  return isObject(value) &&
    hasOnlyKeys(value, allowed) &&
    required.every((key) => isBoundedString(value[key]));
}

function isProjectSummary(value: unknown): value is AssistantProjectSummary {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'completedAt', 'description', 'goal', 'id', 'name', 'priority', 'startDate',
    'status', 'targetDate', 'timezone', 'type', 'updatedAt',
  ])) return false;
  return ['id', 'name', 'priority', 'status', 'timezone', 'type', 'updatedAt']
    .every((key) => isBoundedString(value[key])) &&
    isOptionalString(value.completedAt) && isOptionalString(value.description) &&
    isOptionalString(value.goal) && isOptionalString(value.startDate) &&
    isOptionalString(value.targetDate);
}

function isProjectTask(value: unknown) {
  if (!isStringRecord(value, [
    'deliverableId', 'description', 'dueDate', 'id', 'milestoneId', 'position',
    'priority', 'scheduledFor', 'status', 'title',
  ], ['id', 'priority', 'status', 'title'])) return false;
  return typeof value.position === 'number' && Number.isFinite(value.position) &&
    isOptionalString(value.deliverableId) && isOptionalString(value.description) &&
    isOptionalString(value.dueDate) && isOptionalString(value.milestoneId) &&
    isOptionalString(value.scheduledFor);
}

function isMilestone(value: unknown, deliverable = false) {
  if (!isStringRecord(value, [
    'description', 'dueDate', 'id', 'milestoneId', 'name', 'position', 'status',
    'targetDate',
  ], ['id', 'name', 'status'])) return false;
  return typeof value.position === 'number' && Number.isFinite(value.position) &&
    isOptionalString(value.description) && isOptionalString(value.targetDate) &&
    (!deliverable ||
      (isOptionalString(value.dueDate) && isOptionalString(value.milestoneId)));
}

function isKnowledge(value: unknown) {
  return isStringRecord(
    value,
    ['content', 'id', 'kind', 'title', 'updatedAt'],
    ['content', 'id', 'kind', 'updatedAt'],
  ) && isOptionalString(value.title);
}

function isDecision(value: unknown) {
  return isStringRecord(
    value,
    ['decidedAt', 'id', 'rationale', 'statement'],
    ['decidedAt', 'id', 'statement'],
  ) && isOptionalString(value.rationale);
}

function isWorkSession(value: unknown) {
  return isStringRecord(
    value,
    ['endedAt', 'id', 'startedAt', 'summary', 'title'],
    ['id', 'startedAt'],
  ) && isOptionalString(value.endedAt) && isOptionalString(value.summary) &&
    isOptionalString(value.title);
}

function isResource(value: unknown) {
  return isStringRecord(
    value,
    ['description', 'externalUrl', 'id', 'mimeType', 'name', 'role', 'type'],
    ['id', 'name', 'role', 'type'],
  ) && isOptionalString(value.description) && isOptionalString(value.externalUrl) &&
    isOptionalString(value.mimeType);
}

function isChange(value: unknown) {
  return isStringRecord(
    value,
    ['entityType', 'eventType', 'id', 'occurredAt', 'summary'],
    ['entityType', 'eventType', 'id', 'occurredAt', 'summary'],
  );
}

function isBoundedArray(
  value: unknown,
  maximum: number,
  itemCheck: (item: unknown) => boolean,
) {
  return value === undefined ||
    (Array.isArray(value) && value.length <= maximum && value.every(itemCheck));
}

function isProjectToolArguments(value: unknown, name: AssistantProjectToolName) {
  if (!isObject(value)) return false;

  return name === 'list_projects'
    ? hasOnlyKeys(value, ['includeArchived']) && typeof value.includeArchived === 'boolean'
    : hasOnlyKeys(value, ['focus', 'projectId']) &&
        isFocus(value.focus) &&
        isBoundedString(value.projectId, 200);
}

function isProjectToolResult(value: unknown): value is AssistantProjectToolResult {
  if (!isObject(value) || !isBoundedJson(value)) return false;

  if (value.status === 'error' || value.status === 'not_found') {
    return hasOnlyKeys(value, ['message', 'status']) && isBoundedString(value.message, 200);
  }

  if (value.status !== 'success') return false;

  if ('projects' in value) {
    return hasOnlyKeys(value, ['projects', 'status', 'truncated']) &&
      Array.isArray(value.projects) &&
      value.projects.length <= 20 &&
      value.projects.every(isProjectSummary) &&
      typeof value.truncated === 'boolean';
  }

  return hasOnlyKeys(value, [
    'currentDecisions', 'currentKnowledge', 'deliverables', 'focus', 'milestones',
    'openTasks', 'project', 'recentChanges', 'recentWorkSessions', 'resources',
    'status', 'truncatedSections', 'unresolvedQuestions',
  ]) &&
    isProjectSummary(value.project) &&
    isFocus(value.focus) &&
    Array.isArray(value.truncatedSections) &&
    value.truncatedSections.length <= 9 &&
    value.truncatedSections.every((item) => isBoundedString(item, 50)) &&
    isBoundedArray(value.openTasks, 20, isProjectTask) &&
    isBoundedArray(value.milestones, 12, (item) => isMilestone(item)) &&
    isBoundedArray(value.deliverables, 20, (item) => isMilestone(item, true)) &&
    isBoundedArray(value.currentKnowledge, 20, isKnowledge) &&
    isBoundedArray(value.unresolvedQuestions, 15, isKnowledge) &&
    isBoundedArray(value.currentDecisions, 15, isDecision) &&
    isBoundedArray(value.recentWorkSessions, 10, isWorkSession) &&
    isBoundedArray(value.resources, 15, isResource) &&
    isBoundedArray(value.recentChanges, 15, isChange);
}

function projectToolContract(
  name: AssistantProjectToolName,
  description: string,
  parameters: Record<string, unknown>,
): AssistantToolContract<
  AssistantProjectToolName,
  'server',
  AssistantProjectToolArguments,
  AssistantProjectToolResult
> {
  return {
    execution: 'server',
    isArguments: (value): value is AssistantProjectToolArguments =>
      isProjectToolArguments(value, name),
    isResult: isProjectToolResult,
    name,
    openAI: { description, parameters, strict: true, type: 'function' },
  };
}

export const ASSISTANT_PROJECT_TOOL_CONTRACTS = [
  projectToolContract(
    'list_projects',
    'List a bounded set of the authenticated user’s persistent Project identities, including name, type, description, goal, status, and recency. Use selectively when the user explicitly names a Project, asks about their own ongoing work, uses a descriptive reference such as “the clothing brand,” “that website,” “the grant,” “my comic,” or “the manufacturer thing,” or says the topic was discussed before. Compare these identity clues before asking for an exact Project name. If one Project clearly matches, follow with get_project_context; if several plausibly match, ask a natural clarification instead of guessing or loading all their details. Do not use to classify ordinary conversation as Project-related, or for standalone factual, social, calendar-only, and unrelated questions.',
    {
      type: 'object',
      properties: {
        includeArchived: {
          type: 'boolean',
          description: 'Whether explicitly archived projects are relevant to the request.',
        },
      },
      required: ['includeArchived'],
      additionalProperties: false,
    },
  ),
  projectToolContract(
    'get_project_context',
    'Read a bounded, current view of one authenticated user Project. Choose the smallest useful focus: work for tasks/milestones/sessions, knowledge for accepted facts/decisions/questions/resources, history for recent sessions/changes, overview for status, and comprehensive only when several sections are truly needed. Use the result as evidence for a natural answer, not as a report template. This tool never returns raw session transcripts and never modifies data.',
    {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Exact Project ID returned by list_projects.',
          minLength: 1,
          maxLength: 200,
        },
        focus: {
          type: 'string',
          enum: FOCUSES,
          description: 'The smallest Project information group needed to answer.',
        },
      },
      required: ['projectId', 'focus'],
      additionalProperties: false,
    },
  ),
] as const;
