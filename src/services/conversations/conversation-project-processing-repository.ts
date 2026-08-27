import type {
  ConversationProjectCheckpoint,
  ConversationProjectProcessingPlan,
  ConversationWithMessages,
  PendingProjectCandidate,
} from '../../domain/conversations';
import type { ProjectRepositoryChanges } from '../projects/project-repository';

export type ConversationProcessingClaim = {
  conversation: ConversationWithMessages;
  status: 'processing' | 'processed';
};

export class ConversationProcessingInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationProcessingInProgressError';
  }
}

export class StaleProjectStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleProjectStateError';
  }
}

export type ProjectCommitPrecondition = {
  derivedIdentity: string;
  entityType: 'decision' | 'knowledge' | 'task';
  existingEntityId: string | null;
  expectedUpdatedAt: string | null;
  knowledgeKind: string | null;
  operation: 'create' | 'replace';
};

export interface ConversationProjectProcessingRepository {
  claim(conversationId: string): Promise<ConversationProcessingClaim>;
  commitProjectResult(input: {
    candidates: readonly PendingProjectCandidate[];
    changes: ProjectRepositoryChanges;
    conversationId: string;
    preconditions: readonly ProjectCommitPrecondition[];
    projectId: string;
  }): Promise<'processed' | 'skipped'>;
  complete(conversationId: string): Promise<void>;
  fail(conversationId: string, projectId: string | null, error: string): Promise<void>;
  listCheckpoints(conversationId: string): Promise<ConversationProjectCheckpoint[]>;
  savePlan(
    conversationId: string,
    plan: ConversationProjectProcessingPlan,
    sessions: readonly { projectId: string; sessionId: string }[],
  ): Promise<ConversationProjectProcessingPlan>;
}
