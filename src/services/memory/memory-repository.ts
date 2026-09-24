import type {
  GeneralMemory,
  MemoryAnalysis,
  MemoryExpectedState,
  MemoryProcessingClaim,
  MemoryProjectIdentity,
} from '../../domain/memory';

export type MemorySearchOptions = {
  includeUncertain?: boolean;
  layer?: 'any' | GeneralMemory['layer'];
  limit?: number;
};

export interface MemoryRepository {
  claimNextMessage(conversationId?: string): Promise<MemoryProcessingClaim>;
  commitAnalysis(input: {
    analysis: MemoryAnalysis;
    claimToken: string;
    conversationId: string;
    expectedMemories: MemoryExpectedState[];
    messageId: string;
  }): Promise<void>;
  failMessage(input: {
    claimToken: string;
    conversationId: string;
    error: string;
    messageId: string;
  }): Promise<void>;
  getAnalysisMemories(query: string, limit?: number): Promise<GeneralMemory[]>;
  getProjectIdentities(limit?: number): Promise<MemoryProjectIdentity[]>;
  search(query: string, options?: MemorySearchOptions): Promise<GeneralMemory[]>;
}
