import type { GeneralMemory } from '../../domain/memory';

import type { AssistantToolCall, AssistantToolContract, AssistantToolOutput } from './tool-contract';

export const ASSISTANT_MEMORY_TOOL_NAMES = ['search_general_memory'] as const;
export type AssistantMemoryToolName = typeof ASSISTANT_MEMORY_TOOL_NAMES[number];

export type SearchGeneralMemoryArguments = {
  includeUncertain: boolean;
  layer: 'any' | 'current_state' | 'durable';
  query: string;
};

export type AssistantMemoryResultItem = Pick<GeneralMemory,
  'confidence' | 'content' | 'evidenceCount' | 'id' | 'layer' | 'lastConfirmedAt' |
  'memoryType' | 'provenance' | 'sourceReferences' | 'status' | 'subjectKey' | 'updatedAt'
> & Pick<Partial<GeneralMemory>, 'context' | 'staleAfter' | 'topic' | 'validUntil'>;

export type AssistantMemoryToolResult =
  | { memories: AssistantMemoryResultItem[]; status: 'success'; truncated: boolean; useful?: boolean }
  | { message: string; status: 'error' };

export type AssistantMemoryToolCall = AssistantToolCall<
  AssistantMemoryToolName,
  'server',
  SearchGeneralMemoryArguments
>;
export type AssistantMemoryToolOutput = AssistantToolOutput<
  AssistantMemoryToolName,
  'server',
  AssistantMemoryToolResult
>;

function isArguments(value: unknown): value is SearchGeneralMemoryArguments {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 3 && typeof row.query === 'string' &&
    row.query.trim().length > 0 && row.query.length <= 500 &&
    ['any', 'current_state', 'durable'].includes(String(row.layer)) &&
    typeof row.includeUncertain === 'boolean';
}

function isSource(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.conversationId === 'string' && typeof row.messageId === 'string' &&
    typeof row.occurredAt === 'string' && row.role === 'user';
}

function isResult(value: unknown): value is AssistantMemoryToolResult {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (row.status === 'error') return typeof row.message === 'string' && row.message.length <= 200;
  if (row.status !== 'success' || typeof row.truncated !== 'boolean' ||
    !(row.useful === undefined || typeof row.useful === 'boolean') || !Array.isArray(row.memories) ||
    row.memories.length > 10) return false;
  return row.memories.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const memory = item as Record<string, unknown>;
    return typeof memory.id === 'string' && typeof memory.content === 'string' &&
      typeof memory.subjectKey === 'string' && typeof memory.confidence === 'number' &&
      typeof memory.evidenceCount === 'number' && typeof memory.updatedAt === 'string' &&
      typeof memory.lastConfirmedAt === 'string' && Array.isArray(memory.sourceReferences) &&
      memory.sourceReferences.every(isSource) &&
      ['durable', 'current_state'].includes(String(memory.layer)) &&
      ['background', 'commitment', 'constraint', 'goal', 'preference', 'state']
        .includes(String(memory.memoryType)) &&
      ['current', 'stale', 'expired', 'ambiguous'].includes(String(memory.status)) &&
      ['explicit_statement', 'explicit_decision', 'inferred'].includes(String(memory.provenance));
  });
}

export const ASSISTANT_MEMORY_TOOL_CONTRACTS: readonly AssistantToolContract[] = [{
  execution: 'server',
  isArguments,
  isResult,
  name: 'search_general_memory',
  openAI: {
    description: 'Search owner-scoped durable preferences/background and changing current-state memory without scanning raw conversation History. Required for direct questions recalling the user’s preferences, current state, ongoing goals, recurring constraints, or previously stated personal facts, even without an explicit memory cue. Use a concise query centered on distinctive personal subject terms.',
    parameters: {
      additionalProperties: false,
      properties: {
        includeUncertain: {
          description: 'Include ambiguous, stale, or expired evidence when current memory may be insufficient.',
          type: 'boolean',
        },
        layer: { enum: ['any', 'durable', 'current_state'], type: 'string' },
        query: { maxLength: 500, minLength: 1, type: 'string' },
      },
      required: ['includeUncertain', 'layer', 'query'],
      type: 'object',
    },
    strict: true,
    type: 'function',
  },
}];
