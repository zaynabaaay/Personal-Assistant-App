import type { SupabaseClient } from '@supabase/supabase-js';

import type { AssistantServerToolContext } from '../assistant/server-tool-executor';
import { createServerSupabaseClient } from '../projects/server-project-repository';

export type ConversationHistorySearchRow = {
  completedAt: string;
  content: string;
  conversationId: string;
  occurredAt: string;
  position: number;
  relevance: number;
  role: 'user' | 'assistant';
  truncated: boolean;
};

export type ConversationHistoryEvidenceRow = ConversationHistorySearchRow & {
  directMatch: boolean;
  roleMatch: boolean;
};

export interface ConversationHistorySearchRepository {
  search(expandedQuery: string, maximumConversations: number): Promise<ConversationHistorySearchRow[]>;
  searchEvidence(
    conversationIds: readonly string[],
    expandedQuery: string,
    preferredRole: 'assistant' | 'both' | 'user',
    preferRecent: boolean,
    maximumMessages: number,
  ): Promise<ConversationHistoryEvidenceRow[]>;
}

type Row = Record<string, unknown>;

function requiredString(row: Row, key: string) {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Invalid History search ${key}.`);
  return value;
}

function requiredNumber(row: Row, key: string) {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid History search ${key}.`);
  }
  return value;
}

function toSearchRow(row: Row): ConversationHistorySearchRow {
  const role = requiredString(row, 'role');
  if (role !== 'user' && role !== 'assistant') {
    throw new Error('Invalid History search role.');
  }

  return {
    completedAt: requiredString(row, 'completed_at'),
    content: requiredString(row, 'content'),
    conversationId: requiredString(row, 'conversation_id'),
    occurredAt: requiredString(row, 'occurred_at'),
    position: requiredNumber(row, 'message_position'),
    relevance: requiredNumber(row, 'relevance'),
    role,
    truncated: row.results_truncated === true || row.excerpt_truncated === true,
  };
}

function toEvidenceRow(row: Row): ConversationHistoryEvidenceRow {
  const base = toSearchRow(row);
  if (typeof row.direct_match !== 'boolean' || typeof row.role_match !== 'boolean') {
    throw new Error('Invalid History evidence ranking metadata.');
  }
  return {
    ...base,
    directMatch: row.direct_match,
    roleMatch: row.role_match,
  };
}

export class SupabaseConversationHistorySearchRepository
implements ConversationHistorySearchRepository {
  constructor(private readonly client: SupabaseClient) {}

  async search(expandedQuery: string, maximumConversations: number) {
    const { data, error } = await this.client.rpc(
      'search_completed_conversation_messages',
      {
        p_max_conversations: maximumConversations,
        p_search_query: expandedQuery,
      },
    );
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Invalid History search result.');
    return data.map((row) => toSearchRow(row as Row));
  }


  async searchEvidence(
    conversationIds: readonly string[],
    expandedQuery: string,
    preferredRole: 'assistant' | 'both' | 'user',
    preferRecent: boolean,
    maximumMessages: number,
  ) {
    const { data, error } = await this.client.rpc(
      'search_completed_conversation_evidence',
      {
        p_conversation_ids: [...conversationIds],
        p_max_messages: maximumMessages,
        p_prefer_recent: preferRecent,
        p_preferred_role: preferredRole,
        p_search_query: expandedQuery,
      },
    );
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Invalid History evidence result.');
    return data.map((row) => toEvidenceRow(row as Row));
  }
}

export function createServerConversationHistorySearchRepository(
  context: AssistantServerToolContext,
) {
  return new SupabaseConversationHistorySearchRepository(
    createServerSupabaseClient(context),
  );
}
