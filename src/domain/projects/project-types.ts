export type ProjectId = string;
export type ProjectEntityId = string;
export type ISODate = string;
export type ISODateTime = string;

export type ProjectStatus =
  | 'planned'
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'archived';

export type ProjectPriority = 'low' | 'normal' | 'high' | 'urgent';

export type Project = {
  completedAt?: ISODateTime;
  createdAt: ISODateTime;
  description?: string;
  goal?: string;
  id: ProjectId;
  name: string;
  priority: ProjectPriority;
  startDate?: ISODate;
  status: ProjectStatus;
  targetDate?: ISODate;
  timezone: string;
  type: 'general' | 'grant' | 'website' | 'story' | 'event' | 'business' | 'other';
  updatedAt: ISODateTime;
};

export type ProjectSection = {
  createdAt: ISODateTime;
  id: ProjectEntityId;
  isDefault: boolean;
  position: number;
  projectId: ProjectId;
  status: 'active' | 'archived';
  title: string;
  updatedAt: ISODateTime;
};

export type ProjectMilestone = {
  completedAt?: ISODateTime;
  createdAt: ISODateTime;
  description?: string;
  id: ProjectEntityId;
  name: string;
  position: number;
  projectId: ProjectId;
  status: 'planned' | 'active' | 'completed' | 'cancelled';
  targetDate?: ISODate;
  updatedAt: ISODateTime;
};

export type ProjectDeliverable = {
  completedAt?: ISODateTime;
  createdAt: ISODateTime;
  description?: string;
  dueDate?: ISODate;
  id: ProjectEntityId;
  milestoneId?: ProjectEntityId;
  name: string;
  position: number;
  projectId: ProjectId;
  status: 'planned' | 'in_progress' | 'review' | 'completed' | 'cancelled';
  updatedAt: ISODateTime;
};

export type ProjectTaskStatus =
  | 'todo'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'cancelled';

export type ProjectTask = {
  completedAt?: ISODateTime;
  createdAt: ISODateTime;
  deliverableId?: ProjectEntityId;
  description?: string;
  derivedIdentity?: string;
  dueDate?: ISODate;
  id: ProjectEntityId;
  milestoneId?: ProjectEntityId;
  parentTaskId?: ProjectEntityId;
  position: number;
  priority: ProjectPriority;
  projectId: ProjectId;
  scheduledFor?: ISODateTime;
  sourceSessionId?: ProjectEntityId;
  status: ProjectTaskStatus;
  title: string;
  updatedAt: ISODateTime;
};

export type ProjectKnowledgeKind =
  | 'fact'
  | 'requirement'
  | 'constraint'
  | 'note'
  | 'question';

export type ProjectKnowledgeStatus =
  | 'proposed'
  | 'current'
  | 'resolved'
  | 'superseded'
  | 'archived';

export type ProjectKnowledgeItem = {
  content: string;
  createdAt: ISODateTime;
  derivedIdentity?: string;
  id: ProjectEntityId;
  kind: ProjectKnowledgeKind;
  projectId: ProjectId;
  resolution?: string;
  resolvedAt?: ISODateTime;
  sourceSessionId?: ProjectEntityId;
  status: ProjectKnowledgeStatus;
  supersedesKnowledgeItemId?: ProjectEntityId;
  title?: string;
  updatedAt: ISODateTime;
};

export type ProjectDecision = {
  createdAt: ISODateTime;
  decidedAt: ISODateTime;
  derivedIdentity?: string;
  id: ProjectEntityId;
  projectId: ProjectId;
  rationale?: string;
  sourceSessionId?: ProjectEntityId;
  statement: string;
  status: 'active' | 'superseded' | 'reversed';
  supersedesDecisionId?: ProjectEntityId;
  updatedAt: ISODateTime;
};

export type ProjectWorkSession = {
  createdAt: ISODateTime;
  endedAt?: ISODateTime;
  id: ProjectEntityId;
  projectId: ProjectId;
  sourceConversationId?: string;
  startedAt: ISODateTime;
  summary?: string;
  title?: string;
  updatedAt: ISODateTime;
};

export type ProjectWorkSessionEntry = {
  content: string;
  id: ProjectEntityId;
  kind: 'user_message' | 'assistant_message' | 'note' | 'activity';
  occurredAt: ISODateTime;
  position: number;
  sessionId: ProjectEntityId;
};

export type ProjectResource = {
  byteSize?: number;
  createdAt: ISODateTime;
  description?: string;
  externalUrl?: string;
  height?: number;
  id: ProjectEntityId;
  mimeType?: string;
  name: string;
  originalFilename?: string;
  projectId: ProjectId;
  resourceKind?: 'legacy' | 'uploaded_asset';
  role: 'reference' | 'working';
  sectionId?: ProjectEntityId;
  sourceMetadata?: Record<string, boolean | number | string | null>;
  sourceSessionId?: ProjectEntityId;
  status?: 'current' | 'archived';
  storagePath?: string;
  type: 'document' | 'pdf' | 'spreadsheet' | 'image' | 'link' | 'other';
  updatedAt: ISODateTime;
  width?: number;
};

/** An original uploaded source represented by the existing Project resource domain. */
export type ProjectAsset = ProjectResource & {
  byteSize: number;
  mimeType: string;
  originalFilename: string;
  sectionId: ProjectEntityId;
  resourceKind: 'uploaded_asset';
  status: 'current' | 'archived';
  storagePath: string;
};

export type ProjectChangeEventType =
  | 'task_completed'
  | 'knowledge_accepted'
  | 'knowledge_superseded'
  | 'decision_superseded'
  | 'work_session_closed';

export type ProjectChangeEvent = {
  after?: Record<string, unknown>;
  before?: Record<string, unknown>;
  entityId: ProjectEntityId;
  entityType: 'task' | 'knowledge' | 'decision' | 'work_session';
  eventType: ProjectChangeEventType;
  id: ProjectEntityId;
  occurredAt: ISODateTime;
  projectId: ProjectId;
  sourceSessionId?: ProjectEntityId;
  summary: string;
};

export type CreateKnowledgeReplacement = {
  content: string;
  id?: ProjectEntityId;
  kind: ProjectKnowledgeKind;
  sourceSessionId?: ProjectEntityId;
  title?: string;
};

export type CreateDecisionReplacement = {
  decidedAt?: ISODateTime;
  id?: ProjectEntityId;
  rationale?: string;
  sourceSessionId?: ProjectEntityId;
  statement: string;
};

export type MeaningfulProjectOperation<T> = {
  changeEvent: ProjectChangeEvent;
  value: T;
};
