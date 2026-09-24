import type { ActiveConversation } from '../../domain/conversations';

export type ActiveConversationOutbox = {
  clear(userId: string): Promise<void>;
  load(userId: string): Promise<ActiveConversation | null>;
  save(userId: string, conversation: ActiveConversation): Promise<void>;
};

export function activeConversationOutboxKey(userId: string) {
  return `tina.active-conversation-outbox.v1.${userId}`;
}

export function parseActiveConversationOutbox(value: string | null): ActiveConversation | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ActiveConversation>;
    if (
      typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'string' ||
      typeof parsed.startedAt !== 'string' || typeof parsed.updatedAt !== 'string' ||
      typeof parsed.revision !== 'number' || !Array.isArray(parsed.messages)
    ) return null;
    return parsed as ActiveConversation;
  } catch {
    return null;
  }
}
