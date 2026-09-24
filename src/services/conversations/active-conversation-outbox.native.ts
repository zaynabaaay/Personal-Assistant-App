import type { ActiveConversationOutbox } from './active-conversation-outbox-types';
import {
  activeConversationOutboxKey,
  parseActiveConversationOutbox,
} from './active-conversation-outbox-types';

async function getStorage() {
  const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
  return AsyncStorage;
}

export const activeConversationOutbox: ActiveConversationOutbox = {
  async clear(userId) {
    await (await getStorage()).removeItem(activeConversationOutboxKey(userId));
  },
  async load(userId) {
    return parseActiveConversationOutbox(
      await (await getStorage()).getItem(activeConversationOutboxKey(userId)),
    );
  },
  async save(userId, conversation) {
    await (await getStorage()).setItem(
      activeConversationOutboxKey(userId),
      JSON.stringify(conversation),
    );
  },
};
