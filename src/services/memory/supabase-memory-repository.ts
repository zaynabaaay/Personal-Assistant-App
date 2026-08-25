import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  GeneralMemory,
  MemoryAnalysis,
  MemoryExpectedState,
  MemoryMessageContext,
  MemoryProcessingClaim,
  MemoryProjectIdentity,
  MemorySourceReference,
} from '../../domain/memory';
import { getSupabaseClient } from '../auth/supabase-client';

import type { MemoryRepository, MemorySearchOptions } from './memory-repository';

type Row = Record<string, unknown>;

function stringValue(row: Row, key: string) {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Invalid memory ${key}.`);
  return value;
}

function optionalString(row: Row, key: string) {
  return typeof row[key] === 'string' ? row[key] as string : undefined;
}

function sourceReferences(value: unknown): MemorySourceReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Row;
    if (typeof row.conversation_id !== 'string' || typeof row.message_id !== 'string' ||
      typeof row.occurred_at !== 'string' || row.role !== 'user') return [];
    return [{
      conversationId: row.conversation_id,
      messageId: row.message_id,
      occurredAt: row.occurred_at,
      role: 'user' as const,
    }];
  });
}

export function toGeneralMemory(row: Row): GeneralMemory {
  const confidence = row.confidence;
  const evidenceCount = row.evidence_count;
  if (typeof confidence !== 'number' || typeof evidenceCount !== 'number') {
    throw new Error('Invalid memory confidence.');
  }
  return {
    confidence,
    content: stringValue(row, 'content'),
    ...(optionalString(row, 'context') ? { context: optionalString(row, 'context') } : {}),
    createdAt: stringValue(row, 'created_at'),
    evidenceCount,
    id: stringValue(row, 'id'),
    lastConfirmedAt: stringValue(row, 'last_confirmed_at'),
    layer: stringValue(row, 'layer') as GeneralMemory['layer'],
    memoryType: stringValue(row, 'memory_type') as GeneralMemory['memoryType'],
    provenance: stringValue(row, 'provenance') as GeneralMemory['provenance'],
    ...(typeof row.relevance === 'number' && Number.isFinite(row.relevance)
      ? { relevance: row.relevance }
      : {}),
    sourceReferences: sourceReferences(row.source_references),
    ...(optionalString(row, 'stale_after') ? { staleAfter: optionalString(row, 'stale_after') } : {}),
    status: stringValue(row, 'status') as GeneralMemory['status'],
    subjectKey: stringValue(row, 'subject_key'),
    ...(optionalString(row, 'superseded_by_memory_id') ? {
      supersededByMemoryId: optionalString(row, 'superseded_by_memory_id'),
    } : {}),
    ...(optionalString(row, 'supersedes_memory_id') ? {
      supersedesMemoryId: optionalString(row, 'supersedes_memory_id'),
    } : {}),
    ...(optionalString(row, 'topic') ? { topic: optionalString(row, 'topic') } : {}),
    updatedAt: stringValue(row, 'updated_at'),
    ...(optionalString(row, 'valid_from') ? { validFrom: optionalString(row, 'valid_from') } : {}),
    ...(optionalString(row, 'valid_until') ? { validUntil: optionalString(row, 'valid_until') } : {}),
  };
}

function toClaim(value: unknown): MemoryProcessingClaim {
  if (!value || typeof value !== 'object') throw new Error('Invalid memory processing claim.');
  const row = value as Row;
  if (row.status === 'complete' || row.status === 'processing') return { status: row.status };
  if (row.status !== 'claimed' || typeof row.claimToken !== 'string' ||
    !row.context || typeof row.context !== 'object') {
    throw new Error('Invalid memory processing claim.');
  }
  return {
    claimToken: row.claimToken,
    context: row.context as MemoryMessageContext,
    status: 'claimed',
  };
}

export class SupabaseMemoryRepository implements MemoryRepository {
  constructor(private readonly getClient: () => SupabaseClient = getSupabaseClient) {}

  async claimNextMessage(conversationId?: string) {
    const { data, error } = await this.getClient().rpc('claim_next_memory_message', {
      p_conversation_id: conversationId ?? null,
    });
    if (error) throw error;
    return toClaim(data);
  }

  async commitAnalysis(input: {
    analysis: MemoryAnalysis;
    claimToken: string;
    conversationId: string;
    expectedMemories: MemoryExpectedState[];
    messageId: string;
  }) {
    const { error } = await this.getClient().rpc('commit_memory_analysis', {
      p_analysis: input.analysis,
      p_claim_token: input.claimToken,
      p_conversation_id: input.conversationId,
      p_expected_memories: input.expectedMemories,
      p_message_id: input.messageId,
    });
    if (error) throw error;
  }

  async failMessage(input: {
    claimToken: string;
    conversationId: string;
    error: string;
    messageId: string;
  }) {
    const { error } = await this.getClient().rpc('fail_memory_message', {
      p_claim_token: input.claimToken,
      p_conversation_id: input.conversationId,
      p_error: input.error.slice(0, 1_000),
      p_message_id: input.messageId,
    });
    if (error) throw error;
  }

  async getAnalysisMemories(query: string, limit = 12) {
    const { data, error } = await this.getClient().rpc('get_memory_analysis_context', {
      p_limit: Math.min(Math.max(limit, 1), 12),
      p_query: query,
    });
    if (error) throw error;
    return (data ?? []).map((row: unknown) => toGeneralMemory(row as Row));
  }

  async getProjectIdentities(limit = 8): Promise<MemoryProjectIdentity[]> {
    const { data, error } = await this.getClient().from('projects')
      .select('id,name,description,goal,status,updated_at')
      .in('status', ['active', 'planned', 'paused'])
      .order('updated_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 8));
    if (error) throw error;
    return (data ?? []).map((value) => {
      const row = value as Row;
      return {
        ...(optionalString(row, 'description') ? { description: optionalString(row, 'description') } : {}),
        ...(optionalString(row, 'goal') ? { goal: optionalString(row, 'goal') } : {}),
        id: stringValue(row, 'id'),
        name: stringValue(row, 'name'),
        status: stringValue(row, 'status'),
      };
    });
  }

  async search(query: string, options: MemorySearchOptions = {}) {
    const { data, error } = await this.getClient().rpc('search_general_memories', {
      p_include_uncertain: options.includeUncertain ?? false,
      p_layer: options.layer ?? 'any',
      p_limit: Math.min(Math.max(options.limit ?? 8, 1), 12),
      p_query: query,
    });
    if (error) throw error;
    return (data ?? []).map((row: unknown) => toGeneralMemory(row as Row));
  }
}
