import type {
  GeneralMemory,
  MemoryAnalysis,
  MemoryMessageContext,
  MemoryProjectIdentity,
} from '../../domain/memory';

export interface MemoryAnalyzer {
  analyze(input: {
    context: MemoryMessageContext;
    existingMemories: readonly GeneralMemory[];
    projectIdentities: readonly MemoryProjectIdentity[];
  }): Promise<MemoryAnalysis>;
}
