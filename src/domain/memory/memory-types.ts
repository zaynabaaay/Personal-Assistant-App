export type MemoryLayer = 'durable' | 'current_state';

export type MemoryType =
  | 'background'
  | 'commitment'
  | 'constraint'
  | 'goal'
  | 'preference'
  | 'state';

export type MemoryStatus =
  | 'ambiguous'
  | 'current'
  | 'expired'
  | 'stale'
  | 'superseded';

export type MemoryProvenance =
  | 'explicit_decision'
  | 'explicit_statement'
  | 'inferred';

export type MemorySourceReference = {
  conversationId: string;
  messageId: string;
  occurredAt: string;
  role: 'user';
};

export type GeneralMemory = {
  confidence: number;
  content: string;
  context?: string;
  createdAt: string;
  evidenceCount: number;
  id: string;
  lastConfirmedAt: string;
  layer: MemoryLayer;
  memoryType: MemoryType;
  provenance: MemoryProvenance;
  relevance?: number;
  sourceReferences: MemorySourceReference[];
  staleAfter?: string;
  status: MemoryStatus;
  subjectKey: string;
  supersededByMemoryId?: string;
  supersedesMemoryId?: string;
  topic?: string;
  updatedAt: string;
  validFrom?: string;
  validUntil?: string;
};

export type MemoryCandidateAction =
  | 'ambiguous'
  | 'coexist'
  | 'exception'
  | 'history_only'
  | 'promote'
  | 'repeat'
  | 'supersede';

export type MemoryCandidate = {
  action: MemoryCandidateAction;
  confidence: number;
  content?: string;
  context?: string;
  existingMemoryId?: string;
  layer?: MemoryLayer;
  memoryType?: MemoryType;
  provenance?: MemoryProvenance;
  scope?: 'general' | 'project';
  staleAfter?: string;
  subjectKey?: string;
  topic?: string;
  validFrom?: string;
  validUntil?: string;
};

export type MemoryAnalysis = {
  candidates: MemoryCandidate[];
  version: 1;
};

export type MemoryMessageContext = {
  conversationId: string;
  message: {
    content: string;
    conversationId: string;
    id: string;
    occurredAt: string;
    position: number;
    role: 'user';
  };
  nearbyMessages: {
    content: string;
    id: string;
    occurredAt: string;
    position: number;
    role: 'assistant' | 'user';
  }[];
};

export type MemoryProjectIdentity = {
  description?: string;
  goal?: string;
  id: string;
  name: string;
  status: string;
};

export type MemoryExpectedState = Pick<
  GeneralMemory,
  'content' | 'context' | 'id' | 'provenance' | 'status' | 'subjectKey' | 'updatedAt'
>;

export type MemoryProcessingClaim =
  | { status: 'complete' }
  | { claimToken: string; context: MemoryMessageContext; status: 'claimed' }
  | { status: 'processing' };
