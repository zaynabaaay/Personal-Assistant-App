import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  ConversationProjectCheckpoint,
  ConversationProjectProcessingPlan,
  PendingProjectCandidate,
} from '../../domain/conversations';
import { getSupabaseClient } from '../auth/supabase-client';
import {
  createConversationProjectChangesPayload,
} from '../projects/supabase-project-repository';

import {
  ConversationProcessingInProgressError,
  StaleProjectStateError,
  type ConversationProjectProcessingRepository,
} from './conversation-project-processing-repository';
import { SupabaseConversationRepository } from './supabase-conversation-repository';

type Row = Record<string, unknown>;

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));


function requiredString(row: Row, key: string) {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Invalid processing ${key}.`);
  return value;
}

function toCheckpoint(row: Row): ConversationProjectCheckpoint {
  const attempts = row.processing_attempts;
  if (typeof attempts !== 'number') throw new Error('Invalid processing attempts.');
  return {
    conversationId: requiredString(row, 'conversation_id'),
    ...(typeof row.last_error === 'string' ? { lastError: row.last_error } : {}),
    processingAttempts: attempts,
    projectId: requiredString(row, 'project_id'),
    sessionId: requiredString(row, 'session_id'),
    status: requiredString(row, 'status') as ConversationProjectCheckpoint['status'],
    updatedAt: requiredString(row, 'updated_at'),
  };
}

function candidateRow(value: PendingProjectCandidate) {
  return {
    content: value.content,
    conversation_id: value.conversationId,
    created_at: value.createdAt,
    id: value.id,
    project_id: value.projectId,
    session_id: value.sessionId,
    status: value.status,
  };
}

export class SupabaseConversationProjectProcessingRepository
implements ConversationProjectProcessingRepository {
  constructor(private readonly getClient: () => SupabaseClient = getSupabaseClient) {}

  async claim(conversationId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { data, error } = await this.getClient().rpc(
        'claim_conversation_project_processing',
        { p_conversation_id: conversationId },
      );
      if (error) throw error;
      const conversation = await new SupabaseConversationRepository(this.getClient)
        .getCompletedConversation(conversationId);
      if (!conversation) throw new Error('Completed conversation was not found.');
      if (data !== 'waiting' || conversation.conversation.processingPlan) {
        return {
          conversation,
          status: data === 'processed' ? 'processed' as const : 'processing' as const,
        };
      }
      await wait(250);
    }
    throw new ConversationProcessingInProgressError(
      'Conversation Project processing is already in progress.',
    );
  }

  async savePlan(
    conversationId: string,
    plan: ConversationProjectProcessingPlan,
    sessions: readonly { projectId: string; sessionId: string }[],
  ) {
    const { data, error } = await this.getClient().rpc('save_conversation_project_plan', {
      p_conversation_id: conversationId,
      p_plan: plan,
      p_projects: sessions.map((value) => ({
        project_id: value.projectId,
        session_id: value.sessionId,
      })),
    });
    if (error) throw error;
    if (!data || typeof data !== 'object') throw new Error('Stored processing plan is invalid.');
    return data as unknown as ConversationProjectProcessingPlan;
  }

  async listCheckpoints(conversationId: string) {
    const { data, error } = await this.getClient()
      .from('conversation_project_processing')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('project_id');
    if (error) throw error;
    return (data ?? []).map((row) => toCheckpoint(row as Row));
  }

  async commitProjectResult(input: Parameters<
    ConversationProjectProcessingRepository['commitProjectResult']
  >[0]) {
    const { data, error } = await this.getClient().rpc('commit_conversation_project_result', {
      p_candidates: input.candidates.map(candidateRow),
      p_changes: createConversationProjectChangesPayload(input.changes),
      p_conversation_id: input.conversationId,
      p_preconditions: input.preconditions,
      p_project_id: input.projectId,
    });
    if (error?.code === '40001') throw new StaleProjectStateError(error.message);
    if (error) throw error;
    return data === 'skipped' ? 'skipped' : 'processed';
  }

  async fail(conversationId: string, projectId: string | null, errorMessage: string) {
    const { error } = await this.getClient().rpc('fail_conversation_project_processing', {
      p_conversation_id: conversationId,
      p_error: errorMessage,
      p_project_id: projectId,
    });
    if (error) throw error;
  }

  async complete(conversationId: string) {
    const { error } = await this.getClient().rpc(
      'complete_conversation_project_processing',
      { p_conversation_id: conversationId },
    );
    if (error) throw error;
  }
}
