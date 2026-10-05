export type ConversationId = string;

export type ConversationMessage = {
  content: string;
  conversationId: ConversationId;
  id: string;
  occurredAt: string;
  position: number;
  role: 'assistant' | 'user';
};

export type CompletedConversation = {
  completedAt: string;
  createdAt: string;
  id: ConversationId;
  messageCount: number;
  metadataStatus: 'fallback' | 'generated';
  lastProcessingError?: string;
  processingPlan?: ConversationProjectProcessingPlan;
  processingAttempts: number;
  processingStatus: 'pending' | 'processing' | 'processed' | 'failed';
  startedAt: string;
  status: 'completed';
  summary: string;
  title: string;
  updatedAt: string;
};

export type ConversationWithMessages = {
  conversation: CompletedConversation;
  messages: ConversationMessage[];
};

export type ActiveConversation = {
  createdAt: string;
  id: ConversationId;
  messages: ConversationMessage[];
  revision: number;
  startedAt: string;
  updatedAt: string;
};

export type ConversationProjectCandidateClassification =
  | 'new'
  | 'already_known'
  | 'clear_update'
  | 'confirmed_decision'
  | 'unresolved_question'
  | 'brainstorming'
  | 'ambiguous';

export type ConversationProjectCandidate = {
  classification: ConversationProjectCandidateClassification;
  content: string;
  evidenceMessageIds: string[];
  existingEntityId: string | null;
  knowledgeKind: 'fact' | 'requirement' | 'constraint' | 'note' | 'question' | null;
  rationale: string | null;
  subjectKey: string | null;
  target: 'knowledge' | 'decision' | 'task';
  title: string | null;
  usefulPending: boolean;
};

export type ConversationProjectPlanItem = {
  candidates: ConversationProjectCandidate[];
  projectId: string;
  relevantMessageIds: string[];
  summary: string;
  title: string;
};

export type ConversationProjectProcessingPlan = {
  projects: ConversationProjectPlanItem[];
  version: 2;
};

export type PendingProjectCandidate = {
  content: string;
  conversationId: string;
  createdAt: string;
  id: string;
  projectId: string;
  sessionId: string;
  status: 'pending';
};

export type ConversationProjectCheckpoint = {
  conversationId: string;
  lastError?: string;
  processingAttempts: number;
  projectId: string;
  sessionId: string;
  status: 'pending' | 'processing' | 'processed' | 'skipped' | 'failed';
  updatedAt: string;
};
