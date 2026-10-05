import type { ActiveConversation } from '../../domain/conversations';

import type { ActiveConversationOutbox } from './active-conversation-outbox-types';

const values = new Map<string, ActiveConversation>();

export const activeConversationOutbox: ActiveConversationOutbox = {
  async clear(userId) {
    values.delete(userId);
  },
  async load(userId) {
    const value = values.get(userId);
    return value ? structuredClone(value) : null;
  },
  async save(userId, conversation) {
    values.set(userId, structuredClone(conversation));
  },
};
