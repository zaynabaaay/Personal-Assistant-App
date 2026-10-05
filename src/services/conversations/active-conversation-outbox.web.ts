import type { ActiveConversationOutbox } from './active-conversation-outbox-types';
import {
  activeConversationOutboxKey,
  parseActiveConversationOutbox,
} from './active-conversation-outbox-types';

export const activeConversationOutbox: ActiveConversationOutbox = {
  async clear(userId) {
    globalThis.localStorage?.removeItem(activeConversationOutboxKey(userId));
  },
  async load(userId) {
    return parseActiveConversationOutbox(
      globalThis.localStorage?.getItem(activeConversationOutboxKey(userId)) ?? null,
    );
  },
  async save(userId, conversation) {
    globalThis.localStorage?.setItem(
      activeConversationOutboxKey(userId),
      JSON.stringify(conversation),
    );
  },
};
