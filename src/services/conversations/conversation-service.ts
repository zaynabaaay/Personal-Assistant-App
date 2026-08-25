import type {
  ActiveConversation,
  CompletedConversation,
  ConversationMessage,
  ConversationWithMessages,
} from '../../domain/conversations';

import type { ConversationRepository } from './conversation-repository';
import {
  generateReadableConversationTitle,
  normalizeGeneratedConversationTitle,
} from './conversation-title';

export type ConversationMetadata = { summary: string; title: string };
export type ConversationMetadataGenerator = (
  conversation: ActiveConversation,
) => Promise<ConversationMetadata | null>;

type ConversationServiceOptions = {
  generateMetadata?: ConversationMetadataGenerator;
  now?: () => Date;
};

let fallbackConversationSequence = 1;
let fallbackMessageSequence = 1;

export function createConversationId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  const randomPart = Math.random().toString(36).slice(2, 10);
  return `conversation-${Date.now()}-${randomPart}-${fallbackConversationSequence++}`;
}

export function createConversationMessageId(conversationId: string) {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${conversationId}:message:${globalThis.crypto.randomUUID()}`;
  }

  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${conversationId}:message:${Date.now()}-${randomPart}-${fallbackMessageSequence++}`;
}

export function createActiveConversation(now = new Date()): ActiveConversation {
  const timestamp = now.toISOString();
  return {
    createdAt: timestamp,
    id: createConversationId(),
    messages: [],
    revision: 0,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

export function fallbackConversationMetadata(
  conversation: Pick<ActiveConversation, 'messages' | 'startedAt'>,
): ConversationMetadata {
  const count = conversation.messages.length;
  return {
    summary: `Completed conversation with ${count} message${count === 1 ? '' : 's'}.`,
    title: generateReadableConversationTitle(conversation),
  };
}

function validateTranscript(active: ActiveConversation) {
  const { messages } = active;

  if (messages.length < 1) {
    throw new Error('A conversation requires at least one message.');
  }

  if (
    Number.isNaN(Date.parse(active.createdAt)) ||
    Number.isNaN(Date.parse(active.startedAt)) ||
    Number.isNaN(Date.parse(active.updatedAt))
  ) throw new Error('The active conversation timestamps are invalid.');

  messages.forEach((message, index) => {
    if (
      message.position !== index ||
      message.conversationId !== active.id ||
      !message.content ||
      !['assistant', 'user'].includes(message.role) ||
      !message.id ||
      Number.isNaN(Date.parse(message.occurredAt))
    ) {
      throw new Error('The active conversation transcript is invalid.');
    }
  });
}

export class ConversationService {
  private readonly generateMetadata?: ConversationMetadataGenerator;
  private readonly now: () => Date;
  private readonly repository: ConversationRepository;

  constructor(repository: ConversationRepository, options: ConversationServiceOptions = {}) {
    this.repository = repository;
    this.generateMetadata = options.generateMetadata;
    this.now = options.now ?? (() => new Date());
  }

  async saveActiveConversation(active: ActiveConversation): Promise<ActiveConversation> {
    validateTranscript(active);
    await this.repository.saveActiveConversationAtomically(active);
    const persisted = await this.repository.getActiveConversation();
    if (
      !persisted || persisted.id !== active.id ||
      !isTranscriptPrefix(active.messages, persisted.messages)
    ) throw new Error('The active conversation could not be verified.');
    return persisted;
  }

  getActiveConversation() {
    return this.repository.getActiveConversation();
  }

  async finishConversation(active: ActiveConversation): Promise<ConversationWithMessages> {
    validateTranscript(active);
    const existing = await this.repository.getCompletedConversation(active.id);

    if (existing) {
      if (!sameTranscript(active.messages, existing.messages)) {
        throw new Error('A different completed transcript already uses this conversation ID.');
      }

      const remainingActive = await this.repository.getActiveConversation();
      if (remainingActive?.id === active.id) {
        if (!sameTranscript(remainingActive.messages, existing.messages)) {
          throw new Error('The active and completed conversation transcripts conflict.');
        }
        await this.repository.finalizeActiveConversationAtomically(existing.conversation);
        if ((await this.repository.getActiveConversation())?.id === active.id) {
          throw new Error('The finalized active conversation could not be cleared.');
        }
      }

      return existing;
    }

    let persistedActive: ActiveConversation;
    try {
      persistedActive = await this.saveActiveConversation(active);
    } catch (error) {
      const concurrentlyCompleted = await this.repository.getCompletedConversation(active.id);
      if (concurrentlyCompleted && sameTranscript(active.messages, concurrentlyCompleted.messages)) {
        return concurrentlyCompleted;
      }
      throw error;
    }
    if (!sameTranscript(active.messages, persistedActive.messages)) {
      throw new Error('The active conversation changed in another session.');
    }

    const completedAt = this.now().toISOString();
    const fallback = fallbackConversationMetadata(persistedActive);
    let metadata: ConversationMetadata | null = null;

    if (this.generateMetadata) {
      try {
        const generated = await this.generateMetadata(persistedActive);
        metadata = generated?.title.trim() && generated.summary.trim()
          ? {
              summary: generated.summary.trim(),
              title: normalizeGeneratedConversationTitle(generated.title, persistedActive),
            }
          : null;
      } catch {
        metadata = null;
      }
    }

    const conversation: CompletedConversation = {
      completedAt,
      createdAt: persistedActive.createdAt,
      id: persistedActive.id,
      messageCount: persistedActive.messages.length,
      metadataStatus: metadata ? 'generated' : 'fallback',
      processingAttempts: 0,
      processingStatus: 'pending',
      startedAt: persistedActive.startedAt,
      status: 'completed',
      summary: metadata?.summary || fallback.summary,
      title: metadata?.title || fallback.title,
      updatedAt: completedAt,
    };

    await this.repository.finalizeActiveConversationAtomically(conversation);
    const persisted = await this.repository.getCompletedConversation(active.id);
    const remainingActive = await this.repository.getActiveConversation();

    if (
      !persisted || !sameTranscript(active.messages, persisted.messages) ||
      remainingActive?.id === active.id
    ) {
      throw new Error('The completed conversation could not be verified.');
    }

    return persisted;
  }

  getCompletedConversation(id: string) {
    return this.repository.getCompletedConversation(id);
  }

  deleteCompletedConversation(id: string) {
    return this.repository.deleteCompletedConversation(id);
  }

  listCompletedConversations() {
    return this.repository.listCompletedConversations();
  }
}

function sameTranscript(
  expected: readonly ConversationMessage[],
  actual: readonly ConversationMessage[],
) {
  return expected.length === actual.length && expected.every((message, index) => {
    const saved = actual[index];
    return saved?.id === message.id && saved.position === message.position &&
      saved.role === message.role && saved.content === message.content &&
      Date.parse(saved.occurredAt) === Date.parse(message.occurredAt);
  });
}

function isTranscriptPrefix(
  expected: readonly ConversationMessage[],
  actual: readonly ConversationMessage[],
) {
  return actual.length >= expected.length && sameTranscript(expected, actual.slice(0, expected.length));
}

export async function finishConversationAndReset(
  service: ConversationService,
  active: ActiveConversation,
  reset: () => void,
) {
  const completed = await service.finishConversation(active);
  reset();
  return completed;
}
