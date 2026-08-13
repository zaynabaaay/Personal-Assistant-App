import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  Project,
  ProjectChangeEvent,
  ProjectDecision,
  ProjectDeliverable,
  ProjectKnowledgeItem,
  ProjectMilestone,
  ProjectResource,
  ProjectTask,
  ProjectWorkSession,
  ProjectWorkSessionEntry,
} from '@/domain/projects';
import { getSupabaseClient } from '../auth/supabase-client';

import type {
  ProjectRepository,
  ProjectRepositoryChanges,
} from './project-repository';

type DatabaseRow = Record<string, unknown>;
type ProjectTable =
  | 'project_change_events'
  | 'project_decisions'
  | 'project_deliverables'
  | 'project_knowledge_items'
  | 'project_milestones'
  | 'project_resources'
  | 'project_tasks'
  | 'project_work_session_entries'
  | 'project_work_sessions'
  | 'projects';

function optionalString(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function requiredString(row: DatabaseRow, key: string) {
  const value = optionalString(row[key]);

  if (value === undefined) {
    throw new Error(`Supabase returned an invalid ${key} value.`);
  }

  return value;
}

function requiredNumber(row: DatabaseRow, key: string) {
  const value = row[key];

  if (typeof value !== 'number') {
    throw new Error(`Supabase returned an invalid ${key} value.`);
  }

  return value;
}

function optionalField(key: string, value: unknown) {
  return value === undefined || value === null ? {} : { [key]: value };
}

function baseProjectEntity(row: DatabaseRow) {
  return {
    createdAt: requiredString(row, 'created_at'),
    id: requiredString(row, 'id'),
    projectId: requiredString(row, 'project_id'),
    updatedAt: requiredString(row, 'updated_at'),
  };
}

function toProject(row: DatabaseRow): Project {
  return {
    ...optionalField('completedAt', optionalString(row.completed_at)),
    createdAt: requiredString(row, 'created_at'),
    ...optionalField('description', optionalString(row.description)),
    ...optionalField('goal', optionalString(row.goal)),
    id: requiredString(row, 'id'),
    name: requiredString(row, 'name'),
    priority: requiredString(row, 'priority') as Project['priority'],
    ...optionalField('startDate', optionalString(row.start_date)),
    status: requiredString(row, 'status') as Project['status'],
    ...optionalField('targetDate', optionalString(row.target_date)),
    timezone: requiredString(row, 'timezone'),
    type: requiredString(row, 'type') as Project['type'],
    updatedAt: requiredString(row, 'updated_at'),
  } as Project;
}

function toMilestone(row: DatabaseRow): ProjectMilestone {
  return {
    ...baseProjectEntity(row),
    ...optionalField('completedAt', optionalString(row.completed_at)),
    ...optionalField('description', optionalString(row.description)),
    name: requiredString(row, 'name'),
    position: requiredNumber(row, 'position'),
    status: requiredString(row, 'status') as ProjectMilestone['status'],
    ...optionalField('targetDate', optionalString(row.target_date)),
  } as ProjectMilestone;
}

function toDeliverable(row: DatabaseRow): ProjectDeliverable {
  return {
    ...baseProjectEntity(row),
    ...optionalField('completedAt', optionalString(row.completed_at)),
    ...optionalField('description', optionalString(row.description)),
    ...optionalField('dueDate', optionalString(row.due_date)),
    ...optionalField('milestoneId', optionalString(row.milestone_id)),
    name: requiredString(row, 'name'),
    position: requiredNumber(row, 'position'),
    status: requiredString(row, 'status') as ProjectDeliverable['status'],
  } as ProjectDeliverable;
}

function toTask(row: DatabaseRow): ProjectTask {
  return {
    ...baseProjectEntity(row),
    ...optionalField('completedAt', optionalString(row.completed_at)),
    ...optionalField('deliverableId', optionalString(row.deliverable_id)),
    ...optionalField('description', optionalString(row.description)),
    ...optionalField('dueDate', optionalString(row.due_date)),
    ...optionalField('milestoneId', optionalString(row.milestone_id)),
    ...optionalField('parentTaskId', optionalString(row.parent_task_id)),
    position: requiredNumber(row, 'position'),
    priority: requiredString(row, 'priority') as ProjectTask['priority'],
    ...optionalField('scheduledFor', optionalString(row.scheduled_for)),
    ...optionalField('sourceSessionId', optionalString(row.source_session_id)),
    status: requiredString(row, 'status') as ProjectTask['status'],
    title: requiredString(row, 'title'),
  } as ProjectTask;
}

function toKnowledgeItem(row: DatabaseRow): ProjectKnowledgeItem {
  return {
    ...baseProjectEntity(row),
    content: requiredString(row, 'content'),
    kind: requiredString(row, 'kind') as ProjectKnowledgeItem['kind'],
    ...optionalField('resolution', optionalString(row.resolution)),
    ...optionalField('resolvedAt', optionalString(row.resolved_at)),
    ...optionalField('sourceSessionId', optionalString(row.source_session_id)),
    status: requiredString(row, 'status') as ProjectKnowledgeItem['status'],
    ...optionalField(
      'supersedesKnowledgeItemId',
      optionalString(row.supersedes_knowledge_item_id),
    ),
    ...optionalField('title', optionalString(row.title)),
  } as ProjectKnowledgeItem;
}

function toDecision(row: DatabaseRow): ProjectDecision {
  return {
    ...baseProjectEntity(row),
    decidedAt: requiredString(row, 'decided_at'),
    ...optionalField('rationale', optionalString(row.rationale)),
    ...optionalField('sourceSessionId', optionalString(row.source_session_id)),
    statement: requiredString(row, 'statement'),
    status: requiredString(row, 'status') as ProjectDecision['status'],
    ...optionalField('supersedesDecisionId', optionalString(row.supersedes_decision_id)),
  } as ProjectDecision;
}

function toWorkSession(row: DatabaseRow): ProjectWorkSession {
  return {
    ...baseProjectEntity(row),
    ...optionalField('endedAt', optionalString(row.ended_at)),
    startedAt: requiredString(row, 'started_at'),
    ...optionalField('summary', optionalString(row.summary)),
    ...optionalField('title', optionalString(row.title)),
  } as ProjectWorkSession;
}

function toWorkSessionEntry(row: DatabaseRow): ProjectWorkSessionEntry {
  return {
    content: requiredString(row, 'content'),
    id: requiredString(row, 'id'),
    kind: requiredString(row, 'kind') as ProjectWorkSessionEntry['kind'],
    occurredAt: requiredString(row, 'occurred_at'),
    position: requiredNumber(row, 'position'),
    sessionId: requiredString(row, 'session_id'),
  };
}

function toResource(row: DatabaseRow): ProjectResource {
  return {
    ...baseProjectEntity(row),
    ...optionalField('description', optionalString(row.description)),
    ...optionalField('externalUrl', optionalString(row.external_url)),
    ...optionalField('mimeType', optionalString(row.mime_type)),
    name: requiredString(row, 'name'),
    role: requiredString(row, 'role') as ProjectResource['role'],
    ...optionalField('sourceSessionId', optionalString(row.source_session_id)),
    type: requiredString(row, 'type') as ProjectResource['type'],
  } as ProjectResource;
}

function toChangeEvent(row: DatabaseRow): ProjectChangeEvent {
  return {
    ...optionalField('after', row.after_state),
    ...optionalField('before', row.before_state),
    entityId: requiredString(row, 'entity_id'),
    entityType: requiredString(row, 'entity_type') as ProjectChangeEvent['entityType'],
    eventType: requiredString(row, 'event_type') as ProjectChangeEvent['eventType'],
    id: requiredString(row, 'id'),
    occurredAt: requiredString(row, 'occurred_at'),
    projectId: requiredString(row, 'project_id'),
    ...optionalField('sourceSessionId', optionalString(row.source_session_id)),
    summary: requiredString(row, 'summary'),
  } as ProjectChangeEvent;
}

const nullable = (value: unknown) => value ?? null;

function projectRow(project: Project) {
  return {
    completed_at: nullable(project.completedAt), created_at: project.createdAt,
    description: nullable(project.description), goal: nullable(project.goal), id: project.id,
    name: project.name, priority: project.priority, start_date: nullable(project.startDate),
    status: project.status, target_date: nullable(project.targetDate), timezone: project.timezone,
    type: project.type, updated_at: project.updatedAt,
  };
}

function milestoneRow(value: ProjectMilestone) {
  return { completed_at: nullable(value.completedAt), created_at: value.createdAt,
    description: nullable(value.description), id: value.id, name: value.name,
    position: value.position, project_id: value.projectId, status: value.status,
    target_date: nullable(value.targetDate), updated_at: value.updatedAt };
}

function deliverableRow(value: ProjectDeliverable) {
  return { completed_at: nullable(value.completedAt), created_at: value.createdAt,
    description: nullable(value.description), due_date: nullable(value.dueDate), id: value.id,
    milestone_id: nullable(value.milestoneId), name: value.name, position: value.position,
    project_id: value.projectId, status: value.status, updated_at: value.updatedAt };
}

function taskRow(value: ProjectTask) {
  return { completed_at: nullable(value.completedAt), created_at: value.createdAt,
    deliverable_id: nullable(value.deliverableId), description: nullable(value.description),
    due_date: nullable(value.dueDate), id: value.id, milestone_id: nullable(value.milestoneId),
    parent_task_id: nullable(value.parentTaskId), position: value.position,
    priority: value.priority, project_id: value.projectId,
    scheduled_for: nullable(value.scheduledFor), source_session_id: nullable(value.sourceSessionId),
    status: value.status, title: value.title, updated_at: value.updatedAt };
}

function knowledgeRow(value: ProjectKnowledgeItem) {
  return { content: value.content, created_at: value.createdAt, id: value.id, kind: value.kind,
    project_id: value.projectId, resolution: nullable(value.resolution),
    resolved_at: nullable(value.resolvedAt), source_session_id: nullable(value.sourceSessionId),
    status: value.status, supersedes_knowledge_item_id: nullable(value.supersedesKnowledgeItemId),
    title: nullable(value.title), updated_at: value.updatedAt };
}

function decisionRow(value: ProjectDecision) {
  return { created_at: value.createdAt, decided_at: value.decidedAt, id: value.id,
    project_id: value.projectId, rationale: nullable(value.rationale),
    source_session_id: nullable(value.sourceSessionId), statement: value.statement,
    status: value.status, supersedes_decision_id: nullable(value.supersedesDecisionId),
    updated_at: value.updatedAt };
}

function workSessionRow(value: ProjectWorkSession) {
  return { created_at: value.createdAt, ended_at: nullable(value.endedAt), id: value.id,
    project_id: value.projectId, started_at: value.startedAt, summary: nullable(value.summary),
    title: nullable(value.title), updated_at: value.updatedAt };
}

function workSessionEntryRow(value: ProjectWorkSessionEntry, projectId: string) {
  return { content: value.content, id: value.id, kind: value.kind,
    occurred_at: value.occurredAt, position: value.position, project_id: projectId,
    session_id: value.sessionId };
}

function resourceRow(value: ProjectResource) {
  return { created_at: value.createdAt, description: nullable(value.description),
    external_url: nullable(value.externalUrl), id: value.id, mime_type: nullable(value.mimeType),
    name: value.name, project_id: value.projectId, role: value.role,
    source_session_id: nullable(value.sourceSessionId), type: value.type,
    updated_at: value.updatedAt };
}

function changeEventRow(value: ProjectChangeEvent) {
  return { after_state: nullable(value.after), before_state: nullable(value.before),
    entity_id: value.entityId, entity_type: value.entityType, event_type: value.eventType,
    id: value.id, occurred_at: value.occurredAt, project_id: value.projectId,
    source_session_id: nullable(value.sourceSessionId), summary: value.summary };
}

export class SupabaseProjectRepository implements ProjectRepository {
  constructor(
    private readonly getClient: () => SupabaseClient = getSupabaseClient,
    private readonly ownerId?: string,
  ) {}

  private async upsert(table: ProjectTable, row: DatabaseRow) {
    const { error } = await this.getClient().from(table).upsert(row, {
      defaultToNull: false,
      onConflict: 'owner_id,id',
    });
    if (error) throw error;
  }

  private async getOne<T>(table: ProjectTable, id: string, map: (row: DatabaseRow) => T) {
    let query = this.getClient().from(table).select('*').eq('id', id);
    if (this.ownerId) query = query.eq('owner_id', this.ownerId);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data ? map(data as DatabaseRow) : null;
  }

  private async list<T>(table: ProjectTable, column: string, value: string,
    map: (row: DatabaseRow) => T, orders: string[] = []) {
    let query = this.getClient().from(table).select('*').eq(column, value);
    if (this.ownerId) query = query.eq('owner_id', this.ownerId);
    for (const order of orders) query = query.order(order);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map((row) => map(row as DatabaseRow));
  }

  private async listAll<T>(table: ProjectTable, map: (row: DatabaseRow) => T) {
    let query = this.getClient().from(table).select('*');
    if (this.ownerId) query = query.eq('owner_id', this.ownerId);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map((row) => map(row as DatabaseRow));
  }

  async addChangeEvent(value: ProjectChangeEvent) { await this.upsert('project_change_events', changeEventRow(value)); }
  async getDecision(id: string) { return this.getOne('project_decisions', id, toDecision); }
  async getKnowledgeItem(id: string) { return this.getOne('project_knowledge_items', id, toKnowledgeItem); }
  async getProject(id: string) { return this.getOne('projects', id, toProject); }
  async getTask(id: string) { return this.getOne('project_tasks', id, toTask); }
  async getWorkSession(id: string) { return this.getOne('project_work_sessions', id, toWorkSession); }
  async listChangeEvents(id: string) { return this.list('project_change_events', 'project_id', id, toChangeEvent, ['occurred_at', 'id']); }
  async listDecisions(id: string) { return this.list('project_decisions', 'project_id', id, toDecision); }
  async listDeliverables(id: string) { return this.list('project_deliverables', 'project_id', id, toDeliverable, ['position', 'id']); }
  async listKnowledgeItems(id: string) { return this.list('project_knowledge_items', 'project_id', id, toKnowledgeItem); }
  async listMilestones(id: string) { return this.list('project_milestones', 'project_id', id, toMilestone, ['position', 'id']); }
  async listProjects() { return this.listAll('projects', toProject); }
  async listResources(id: string) { return this.list('project_resources', 'project_id', id, toResource); }
  async listTasks(id: string) { return this.list('project_tasks', 'project_id', id, toTask, ['position', 'id']); }
  async listWorkSessionEntries(id: string) { return this.list('project_work_session_entries', 'session_id', id, toWorkSessionEntry, ['position', 'occurred_at', 'id']); }
  async listWorkSessions(id: string) { return this.list('project_work_sessions', 'project_id', id, toWorkSession, ['started_at', 'id']); }
  async saveDecision(value: ProjectDecision) { await this.upsert('project_decisions', decisionRow(value)); }
  async saveDeliverable(value: ProjectDeliverable) { await this.upsert('project_deliverables', deliverableRow(value)); }
  async saveKnowledgeItem(value: ProjectKnowledgeItem) { await this.upsert('project_knowledge_items', knowledgeRow(value)); }
  async saveMilestone(value: ProjectMilestone) { await this.upsert('project_milestones', milestoneRow(value)); }
  async saveProject(value: Project) { await this.upsert('projects', projectRow(value)); }
  async saveResource(value: ProjectResource) { await this.upsert('project_resources', resourceRow(value)); }
  async saveTask(value: ProjectTask) { await this.upsert('project_tasks', taskRow(value)); }
  async saveWorkSession(value: ProjectWorkSession) { await this.upsert('project_work_sessions', workSessionRow(value)); }

  async saveWorkSessionEntry(value: ProjectWorkSessionEntry) {
    const session = await this.getWorkSession(value.sessionId);
    if (!session) throw new Error('The work session for this entry was not found.');
    await this.upsert('project_work_session_entries', workSessionEntryRow(value, session.projectId));
  }

  async saveAtomically(changes: ProjectRepositoryChanges) {
    const changedSessions = new Map(
      (changes.workSessions ?? []).map((session) => [session.id, session]),
    );
    const entryRows = await Promise.all((changes.workSessionEntries ?? []).map(async (entry) => {
      const session = changedSessions.get(entry.sessionId) ?? await this.getWorkSession(entry.sessionId);
      if (!session) throw new Error('The work session for this entry was not found.');
      return workSessionEntryRow(entry, session.projectId);
    }));
    const payload = {
      change_events: (changes.changeEvents ?? []).map(changeEventRow),
      decisions: (changes.decisions ?? []).map(decisionRow),
      deliverables: (changes.deliverables ?? []).map(deliverableRow),
      knowledge_items: (changes.knowledgeItems ?? []).map(knowledgeRow),
      milestones: (changes.milestones ?? []).map(milestoneRow),
      projects: (changes.projects ?? []).map(projectRow),
      resources: (changes.resources ?? []).map(resourceRow),
      tasks: (changes.tasks ?? []).map(taskRow),
      work_session_entries: entryRows,
      work_sessions: (changes.workSessions ?? []).map(workSessionRow),
    };
    const { error } = await this.getClient().rpc('commit_project_changes', { p_changes: payload });
    if (error) throw error;
  }

}
