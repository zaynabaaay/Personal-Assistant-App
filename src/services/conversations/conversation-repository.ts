import type {
  ActiveConversation,
  CompletedConversation,
  ConversationWithMessages,
} from '../../domain/conversations';

export interface ConversationRepository {
  deleteCompletedConversation(id: string): Promise<boolean>;
  finalizeActiveConversationAtomically(conversation: CompletedConversation): Promise<void>;
  getActiveConversation(): Promise<ActiveConversation | null>;
  getCompletedConversation(id: string): Promise<ConversationWithMessages | null>;
  listCompletedConversations(): Promise<CompletedConversation[]>;
  saveActiveConversationAtomically(conversation: ActiveConversation): Promise<void>;
  updateCompletedConversationTitle(
    id: string,
    expectedTitle: string,
    title: string,
  ): Promise<boolean>;
}
