import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  ActiveConversation,
  CompletedConversation,
  ConversationMessage,
  ConversationWithMessages,
} from '../../domain/conversations';
import { getSupabaseClient } from '../auth/supabase-client';

import type { ConversationRepository } from './conversation-repository';
import { ConversationService } from './conversation-service';

type Row = Record<string, unknown>;

function requiredString(row: Row, key: string) {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Invalid conversation ${key}.`);
  return value;
}

function requiredNumber(row: Row, key: string) {
  const value = row[key];
  if (typeof value !== 'number') throw new Error(`Invalid conversation ${key}.`);
  return value;
}

function toConversation(row: Row): CompletedConversation {
  const processingPlan = row.processing_plan;
  const lastProcessingError = row.last_processing_error;

  return {
    completedAt: requiredString(row, 'completed_at'),
    createdAt: requiredString(row, 'created_at'),
    id: requiredString(row, 'id'),
    messageCount: requiredNumber(row, 'message_count'),
    metadataStatus: requiredString(row, 'metadata_status') as CompletedConversation['metadataStatus'],
    ...(typeof lastProcessingError === 'string' ? { lastProcessingError } : {}),
    ...(processingPlan && typeof processingPlan === 'object'
      ? { processingPlan: processingPlan as CompletedConversation['processingPlan'] }
      : {}),
    processingAttempts: requiredNumber(row, 'processing_attempts'),
    processingStatus: requiredString(row, 'processing_status') as CompletedConversation['processingStatus'],
    startedAt: requiredString(row, 'started_at'),
    status: 'completed',
    summary: requiredString(row, 'summary'),
    title: requiredString(row, 'title'),
    updatedAt: requiredString(row, 'updated_at'),
  };
}

function toMessage(row: Row): ConversationMessage {
  return {
    content: requiredString(row, 'content'),
    conversationId: requiredString(row, 'conversation_id'),
    id: requiredString(row, 'id'),
    occurredAt: requiredString(row, 'occurred_at'),
    position: requiredNumber(row, 'position'),
    role: requiredString(row, 'role') as ConversationMessage['role'],
  };
}

function toActiveConversation(row: Row, messages: ConversationMessage[]): ActiveConversation {
  return {
    createdAt: requiredString(row, 'created_at'),
    id: requiredString(row, 'id'),
    messages,
    revision: requiredNumber(row, 'revision'),
    startedAt: requiredString(row, 'started_at'),
    updatedAt: requiredString(row, 'updated_at'),
  };
}

function activeConversationRow(value: ActiveConversation) {
  return {
    created_at: value.createdAt,
    id: value.id,
    started_at: value.startedAt,
    updated_at: value.updatedAt,
  };
}

function conversationRow(value: CompletedConversation) {
  return {
    completed_at: value.completedAt,
    created_at: value.createdAt,
    id: value.id,
    message_count: value.messageCount,
    metadata_status: value.metadataStatus,
    last_processing_error: value.lastProcessingError ?? null,
    processing_plan: value.processingPlan ?? null,
    processing_attempts: value.processingAttempts,
    processing_status: value.processingStatus,
    started_at: value.startedAt,
    status: value.status,
    summary: value.summary,
    title: value.title,
    updated_at: value.updatedAt,
  };
}

function messageRow(value: ConversationMessage) {
  return {
    content: value.content,
    conversation_id: value.conversationId,
    id: value.id,
    occurred_at: value.occurredAt,
    position: value.position,
    role: value.role,
  };
}

export class SupabaseConversationRepository implements ConversationRepository {
  constructor(private readonly getClient: () => SupabaseClient = getSupabaseClient) {}

  async finalizeActiveConversationAtomically(conversation: CompletedConversation) {
    const { error } = await this.getClient().rpc('finalize_active_conversation', {
      p_conversation: conversationRow(conversation),
    });
    if (error) throw error;
  }

  async deleteCompletedConversation(id: string) {
    const { data, error } = await this.getClient().rpc('delete_completed_conversation', {
      p_conversation_id: id,
    });
    if (error) throw error;
    return data === true;
  }

  async getActiveConversation(): Promise<ActiveConversation | null> {
    const { data: conversationData, error: conversationError } = await this.getClient()
      .from('active_conversations').select('*').maybeSingle();
    if (conversationError) throw conversationError;
    if (!conversationData) return null;

    const id = requiredString(conversationData as Row, 'id');
    const { data: messageData, error: messageError } = await this.getClient()
      .from('active_conversation_messages').select('*').eq('conversation_id', id)
      .order('position').order('id');
    if (messageError) throw messageError;
    return toActiveConversation(
      conversationData as Row,
      (messageData ?? []).map((row) => toMessage(row as Row)),
    );
  }

  async getCompletedConversation(id: string): Promise<ConversationWithMessages | null> {
    let conversationQuery = this.getClient()
      .from('completed_conversations').select('*').eq('id', id);
    const { data: conversationData, error: conversationError } =
      await conversationQuery.maybeSingle();
    if (conversationError) throw conversationError;
    if (!conversationData) return null;

    let messagesQuery = this.getClient().from('conversation_messages')
      .select('*').eq('conversation_id', id).order('position').order('id');
    const { data: messageData, error: messageError } = await messagesQuery;
    if (messageError) throw messageError;

    return {
      conversation: toConversation(conversationData as Row),
      messages: (messageData ?? []).map((row) => toMessage(row as Row)),
    };
  }

  async listCompletedConversations() {
    let query = this.getClient().from('completed_conversations')
      .select('*').eq('status', 'completed').order('completed_at', { ascending: false })
      .order('id');
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map((row) => toConversation(row as Row));
  }

  async saveActiveConversationAtomically(conversation: ActiveConversation) {
    const { error } = await this.getClient().rpc('save_active_conversation', {
      p_conversation: activeConversationRow(conversation),
      p_messages: conversation.messages.map(messageRow),
    });
    if (error) throw error;
  }

  async updateCompletedConversationTitle(id: string, expectedTitle: string, title: string) {
    const { data, error } = await this.getClient().rpc('update_completed_conversation_title', {
      p_conversation_id: id,
      p_expected_title: expectedTitle,
      p_title: title,
    });
    if (error) throw error;
    return data === true;
  }
}

export const conversationService = new ConversationService(
  new SupabaseConversationRepository(),
);
