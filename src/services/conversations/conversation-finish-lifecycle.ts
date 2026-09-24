import type {
  ActiveConversation,
  ConversationWithMessages,
} from '../../domain/conversations';

import type { ConversationService } from './conversation-service';

export type ConversationProcessingRequestResult = {
  projectCount?: number;
  status: 'processed' | 'already_processed' | 'processing';
};

export type FinishConversationLifecycleResult = {
  completed: ConversationWithMessages;
  processingStatus: 'processed' | 'processing' | 'failed';
};

type FinishConversationLifecycleOptions = {
  active: ActiveConversation;
  onPersisted?: (completed: ConversationWithMessages) => void;
  process: (conversationId: string) => Promise<ConversationProcessingRequestResult>;
  processMemory?: (conversationId: string) => Promise<unknown>;
  reset: () => void;
  service: Pick<ConversationService, 'finishConversation'>;
};

export async function finishConversationLifecycle(
  options: FinishConversationLifecycleOptions,
): Promise<FinishConversationLifecycleResult> {
  const completed = await options.service.finishConversation(options.active);

  // Clearing Home is allowed only after the completed transcript has been
  // persisted and read back successfully. Project organization is a separate,
  // retryable lifecycle and cannot turn this saved result into a save failure.
  options.reset();
  options.onPersisted?.(completed);

  // Memory retry is deliberately independent from Project processing and from
  // the already successful History/reset transaction. The bounded client drain
  // can continue after this lifecycle returns and is safe to invoke again.
  void options.processMemory?.(completed.conversation.id).catch(() => undefined);

  try {
    const processing = await options.process(completed.conversation.id);
    return {
      completed,
      processingStatus: processing.status === 'processing' ? 'processing' : 'processed',
    };
  } catch {
    return { completed, processingStatus: 'failed' };
  }
}
