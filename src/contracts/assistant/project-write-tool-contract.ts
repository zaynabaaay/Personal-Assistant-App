import type { AssistantToolCall, AssistantToolContract, AssistantToolOutput } from './tool-contract';

export const ASSISTANT_PROJECT_WRITE_TOOL_NAMES = [
  'create_project',
  'update_project',
  'manage_project_work',
  'record_project_truth',
] as const;

export type AssistantProjectWriteToolName =
  (typeof ASSISTANT_PROJECT_WRITE_TOOL_NAMES)[number];

export type CreateProjectToolArguments = {
  description: string | null;
  goal: string | null;
  name: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  startDate: string | null;
  status: 'planned' | 'active' | 'paused';
  targetDate: string | null;
  timezone: string;
  type: 'general' | 'grant' | 'website' | 'story' | 'event' | 'business' | 'other';
};

export type UpdateProjectToolArguments = {
  description: string | null;
  goal: string | null;
  name: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent' | null;
  projectId: string | null;
  startDate: string | null;
  status: 'planned' | 'active' | 'paused' | 'completed' | 'cancelled' | 'archived' | null;
  targetDate: string | null;
  type: 'general' | 'grant' | 'website' | 'story' | 'event' | 'business' | 'other' | null;
};

export type ManageProjectWorkToolArguments = {
  description: string | null;
  dueDate: string | null;
  entityId: string | null;
  milestoneId: string | null;
  name: string | null;
  operation:
    | 'create_task' | 'update_task' | 'complete_task'
    | 'create_milestone' | 'update_milestone'
    | 'create_deliverable' | 'update_deliverable';
  priority: 'low' | 'normal' | 'high' | 'urgent' | null;
  projectId: string | null;
  status: string | null;
  targetDate: string | null;
};

export type RecordProjectTruthToolArguments = {
  confirmation: 'explicit' | 'confirmed_replacement';
  content: string | null;
  entityId: string | null;
  kind: 'fact' | 'requirement' | 'constraint' | 'note' | null;
  operation: 'add_knowledge' | 'add_question' | 'add_decision' | 'replace_knowledge' | 'replace_decision';
  projectId: string | null;
  rationale: string | null;
  statement: string | null;
  title: string | null;
};

export type AssistantProjectWriteToolArguments =
  | CreateProjectToolArguments
  | UpdateProjectToolArguments
  | ManageProjectWorkToolArguments
  | RecordProjectTruthToolArguments;

export type AssistantProjectWriteToolResult =
  | {
      entity: { id: string; kind: string; label: string; projectId: string; state?: string };
      message: string;
      outcome: 'created' | 'unchanged' | 'updated';
      status: 'success';
    }
  | { message: string; status: 'clarification_required' | 'confirmation_required' | 'error' | 'not_found' };

export type AssistantProjectWriteToolCall = AssistantToolCall<
  AssistantProjectWriteToolName,
  'server',
  AssistantProjectWriteToolArguments
>;

export type AssistantProjectWriteToolOutput = AssistantToolOutput<
  AssistantProjectWriteToolName,
  'server',
  AssistantProjectWriteToolResult
>;

const PROJECT_FIELDS = ['description', 'goal', 'name', 'priority', 'projectId', 'startDate', 'status', 'targetDate', 'type'];
const WORK_FIELDS = ['description', 'dueDate', 'entityId', 'milestoneId', 'name', 'operation', 'priority', 'projectId', 'status', 'targetDate'];
const TRUTH_FIELDS = ['confirmation', 'content', 'entityId', 'kind', 'operation', 'projectId', 'rationale', 'statement', 'title'];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function nullableString(value: unknown, maximum = 2_000): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= maximum);
}

function boundedString(value: unknown, maximum = 2_000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function isArguments(value: unknown, name: AssistantProjectWriteToolName) {
  if (!isObject(value)) return false;
  if (name === 'create_project') {
    const keys = PROJECT_FIELDS.filter((key) => key !== 'projectId').concat('timezone');
    return hasExactKeys(value, keys) && nullableString(value.description) && nullableString(value.goal) &&
      boundedString(value.name, 300) && nullableString(value.startDate, 10) && nullableString(value.targetDate, 10) &&
      boundedString(value.timezone, 100) && oneOf(value.priority, ['low', 'normal', 'high', 'urgent']) &&
      oneOf(value.status, ['planned', 'active', 'paused']) &&
      oneOf(value.type, ['general', 'grant', 'website', 'story', 'event', 'business', 'other']);
  }
  if (name === 'update_project') {
    return hasExactKeys(value, PROJECT_FIELDS) && nullableString(value.description) && nullableString(value.goal) &&
      nullableString(value.name, 300) && nullableString(value.projectId, 200) && nullableString(value.startDate, 10) &&
      nullableString(value.targetDate, 10) && (value.priority === null || oneOf(value.priority, ['low', 'normal', 'high', 'urgent'])) &&
      (value.status === null || oneOf(value.status, ['planned', 'active', 'paused', 'completed', 'cancelled', 'archived'])) &&
      (value.type === null || oneOf(value.type, ['general', 'grant', 'website', 'story', 'event', 'business', 'other']));
  }
  if (name === 'manage_project_work') {
    return hasExactKeys(value, WORK_FIELDS) && nullableString(value.description) && nullableString(value.dueDate, 10) &&
      nullableString(value.entityId, 200) && nullableString(value.milestoneId, 200) && nullableString(value.name, 300) &&
      nullableString(value.projectId, 200) && (value.status === null || oneOf(value.status, ['todo', 'in_progress', 'blocked', 'cancelled', 'planned', 'active', 'completed', 'review'])) && nullableString(value.targetDate, 10) &&
      (value.priority === null || oneOf(value.priority, ['low', 'normal', 'high', 'urgent'])) &&
      oneOf(value.operation, ['create_task', 'update_task', 'complete_task', 'create_milestone', 'update_milestone', 'create_deliverable', 'update_deliverable']);
  }
  return hasExactKeys(value, TRUTH_FIELDS) && nullableString(value.content) && nullableString(value.entityId, 200) &&
    nullableString(value.projectId, 200) && nullableString(value.rationale) && nullableString(value.statement) &&
    nullableString(value.title, 300) && (value.kind === null || oneOf(value.kind, ['fact', 'requirement', 'constraint', 'note'])) &&
    oneOf(value.confirmation, ['explicit', 'confirmed_replacement']) &&
    oneOf(value.operation, ['add_knowledge', 'add_question', 'add_decision', 'replace_knowledge', 'replace_decision']);
}

function isResult(value: unknown): value is AssistantProjectWriteToolResult {
  if (!isObject(value) || !boundedString(value.message, 500)) return false;
  if (value.status !== 'success') {
    return Object.keys(value).length === 2 && oneOf(value.status, ['clarification_required', 'confirmation_required', 'error', 'not_found']);
  }
  if (!isObject(value.entity) || !hasExactKeys(value, ['entity', 'message', 'outcome', 'status'])) return false;
  if (!Object.keys(value.entity).every((key) => ['id', 'kind', 'label', 'projectId', 'state'].includes(key))) return false;
  return boundedString(value.entity.id, 200) && boundedString(value.entity.kind, 50) &&
    boundedString(value.entity.label, 1_000) && boundedString(value.entity.projectId, 200) &&
    (value.entity.state === undefined || boundedString(value.entity.state, 50)) &&
    oneOf(value.outcome, ['created', 'unchanged', 'updated']);
}

function nullableStringSchema(description: string, maximum = 2_000) {
  return { description, type: ['string', 'null'], maxLength: maximum };
}

function contract(name: AssistantProjectWriteToolName, description: string, properties: Record<string, unknown>, required: string[]): AssistantToolContract<AssistantProjectWriteToolName, 'server', AssistantProjectWriteToolArguments, AssistantProjectWriteToolResult> {
  return { execution: 'server', isArguments: (value): value is AssistantProjectWriteToolArguments => isArguments(value, name),
    isResult, name, openAI: { description, parameters: { type: 'object', properties, required, additionalProperties: false }, strict: true, type: 'function' } };
}

const priorities = ['low', 'normal', 'high', 'urgent'];
const projectTypes = ['general', 'grant', 'website', 'story', 'event', 'business', 'other'];

export const ASSISTANT_PROJECT_WRITE_TOOL_CONTRACTS = [
  contract('create_project', 'Create one Project only when the user clearly and explicitly asks to create it. Exact duplicate names are returned unchanged. Never use for brainstorming.', {
    description: nullableStringSchema('Optional explicit description.'), goal: nullableStringSchema('Optional explicit goal.'),
    name: { type: 'string', minLength: 1, maxLength: 300 }, priority: { type: 'string', enum: priorities },
    startDate: nullableStringSchema('ISO date or null.', 10), status: { type: 'string', enum: ['planned', 'active', 'paused'] },
    targetDate: nullableStringSchema('ISO date or null.', 10), timezone: { type: 'string', minLength: 1, maxLength: 100 },
    type: { type: 'string', enum: projectTypes },
  }, ['description', 'goal', 'name', 'priority', 'startDate', 'status', 'targetDate', 'timezone', 'type']),
  contract('update_project', 'Update explicit basic fields on one unambiguously resolved Project. Read Projects first when the ID is unknown. Use null for every field not requested. If the Project is ambiguous, pass null projectId so Tina can clarify instead of guessing.', {
    description: nullableStringSchema('New description, or null.'), goal: nullableStringSchema('New goal, or null.'),
    name: nullableStringSchema('New Project name, or null.', 300), priority: { type: ['string', 'null'], enum: [...priorities, null] },
    projectId: nullableStringSchema('Exact resolved Project ID, or null when ambiguous.', 200), startDate: nullableStringSchema('New ISO date, or null.', 10),
    status: { type: ['string', 'null'], enum: ['planned', 'active', 'paused', 'completed', 'cancelled', 'archived', null] },
    targetDate: nullableStringSchema('New ISO target date, or null.', 10), type: { type: ['string', 'null'], enum: [...projectTypes, null] },
  }, PROJECT_FIELDS),
  contract('manage_project_work', 'Create or explicitly update a task, milestone, or deliverable, or complete a task. Resolve exact Project/entity IDs with read tools first. Use null for irrelevant fields. Never guess an ambiguous reference; null IDs produce clarification instead of a write. Exact duplicates are returned unchanged.', {
    description: nullableStringSchema('Description update or null.'), dueDate: nullableStringSchema('Task/deliverable ISO due date or null.', 10),
    entityId: nullableStringSchema('Exact existing entity ID for update/complete, otherwise null.', 200), milestoneId: nullableStringSchema('Exact parent milestone ID or null.', 200),
    name: nullableStringSchema('Task title or milestone/deliverable name, otherwise null.', 300),
    operation: { type: 'string', enum: ['create_task', 'update_task', 'complete_task', 'create_milestone', 'update_milestone', 'create_deliverable', 'update_deliverable'] },
    priority: { type: ['string', 'null'], enum: [...priorities, null] }, projectId: nullableStringSchema('Exact resolved Project ID, or null when ambiguous.', 200),
    status: { type: ['string', 'null'], enum: ['todo', 'in_progress', 'blocked', 'cancelled', 'planned', 'active', 'completed', 'review', null], description: 'Explicit status valid for the selected item, or null.' }, targetDate: nullableStringSchema('Milestone ISO target date or null.', 10),
  }, WORK_FIELDS),
  contract('record_project_truth', 'Add accepted knowledge, an unresolved question, or a confirmed decision; or replace current knowledge/decision while preserving its superseded record. Read current knowledge first for duplicates and replacement IDs. Do not call for maybe, perhaps, what-if, brainstorming, or other uncertainty. Replacements require confirmed_replacement only after the user directly confirms saving the new truth.', {
    confirmation: { type: 'string', enum: ['explicit', 'confirmed_replacement'] }, content: nullableStringSchema('Knowledge/question content or null.'),
    entityId: nullableStringSchema('Exact current knowledge/decision ID for replacement, otherwise null.', 200),
    kind: { type: ['string', 'null'], enum: ['fact', 'requirement', 'constraint', 'note', null] },
    operation: { type: 'string', enum: ['add_knowledge', 'add_question', 'add_decision', 'replace_knowledge', 'replace_decision'] },
    projectId: nullableStringSchema('Exact resolved Project ID, or null when ambiguous.', 200), rationale: nullableStringSchema('Decision rationale or null.'),
    statement: nullableStringSchema('Decision statement or null.'), title: nullableStringSchema('Optional knowledge title or null.', 300),
  }, TRUTH_FIELDS),
] as const;
