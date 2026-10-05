import type {
  AssistantMemoryToolCall,
  AssistantMemoryToolOutput,
} from '../../contracts/assistant';
import type { GeneralMemory } from '../../domain/memory';
import type { MemoryRepository } from '../../services/memory/memory-repository';
import { SupabaseMemoryRepository } from '../../services/memory/supabase-memory-repository';
import { createServerSupabaseClient } from '../projects/server-project-repository';

import type { AssistantServerToolContext } from './server-tool-executor';

const MAX_RESULTS = 10;
// Strong matches score above 100. Partial matches are dominated by the
// matched-term coverage component (0..10), so six separates a substantive
// lexical overlap from a generic one-term distractor in natural recall queries.
export const MEMORY_USEFUL_RELEVANCE_THRESHOLD = 6;

function isUseful(memory: GeneralMemory) {
  return memory.relevance === undefined ||
    memory.relevance >= MEMORY_USEFUL_RELEVANCE_THRESHOLD;
}

export function createAssistantMemoryToolExecutor(
  repositoryFactory: (context: AssistantServerToolContext) => Pick<MemoryRepository, 'search'> =
    (context) => new SupabaseMemoryRepository(() => createServerSupabaseClient(context)),
) {
  return async (
    call: AssistantMemoryToolCall,
    context: AssistantServerToolContext,
  ): Promise<AssistantMemoryToolOutput> => {
    try {
      const memories = await repositoryFactory(context).search(call.arguments.query, {
        includeUncertain: call.arguments.includeUncertain,
        layer: call.arguments.layer,
        limit: MAX_RESULTS,
      });
      const boundedMemories = memories.slice(0, MAX_RESULTS);
      return {
        callId: call.callId,
        execution: 'server',
        name: call.name,
        result: {
          memories: boundedMemories.map((memory: GeneralMemory) => ({
            confidence: memory.confidence,
            content: memory.content,
            ...(memory.context ? { context: memory.context } : {}),
            evidenceCount: memory.evidenceCount,
            id: memory.id,
            lastConfirmedAt: memory.lastConfirmedAt,
            layer: memory.layer,
            memoryType: memory.memoryType,
            provenance: memory.provenance,
            sourceReferences: memory.sourceReferences.slice(-5),
            ...(memory.staleAfter ? { staleAfter: memory.staleAfter } : {}),
            status: memory.status,
            subjectKey: memory.subjectKey,
            ...(memory.topic ? { topic: memory.topic } : {}),
            updatedAt: memory.updatedAt,
            ...(memory.validUntil ? { validUntil: memory.validUntil } : {}),
          })),
          status: 'success',
          truncated: memories.length > MAX_RESULTS || memories.some((memory: GeneralMemory) =>
            memory.sourceReferences.length > 5),
          useful: boundedMemories.some(isUseful),
        },
      };
    } catch {
      return {
        callId: call.callId,
        execution: 'server',
        name: call.name,
        result: { message: 'Remembered context is temporarily unavailable.', status: 'error' },
      };
    }
  };
}

export const executeAssistantMemoryTool = createAssistantMemoryToolExecutor();
