import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { CompletedConversation } from '@/domain/conversations';

import { chatMetadata, groupChats } from './chat-presentation';

type ChatsListProps = {
  compact?: boolean;
  conversations: CompletedConversation[];
  onSelectChat: (conversationId: string) => void;
};

export function ChatsList({ compact = false, conversations, onSelectChat }: ChatsListProps) {
  return (
    <ScrollView
      contentContainerStyle={[styles.list, compact && styles.compactList]}
      showsVerticalScrollIndicator={false}
      style={styles.scroll}
      testID={compact ? 'chats-drawer-list' : 'chats-screen-list'}
    >
      {groupChats(conversations).map((group) => (
        <View key={group.title}>
          <Text style={[styles.groupTitle, compact && styles.compactGroupTitle]}>
            {group.title}
          </Text>
          {group.conversations.map((conversation) => (
            <Pressable
              accessibilityHint={chatMetadata(conversation)}
              accessibilityRole="button"
              key={conversation.id}
              onPress={() => onSelectChat(conversation.id)}
              style={({ pressed }) => [
                styles.row,
                compact && styles.compactRow,
                pressed && styles.pressed,
              ]}
            >
              <Text numberOfLines={compact ? 1 : 2} style={[styles.title, compact && styles.compactTitle]}>
                {conversation.title}
              </Text>
              <Text numberOfLines={1} style={[styles.metadata, compact && styles.compactMetadata]}>
                {chatMetadata(conversation)}
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  list: { paddingBottom: 32, paddingHorizontal: 24, paddingTop: 8 },
  compactList: { paddingBottom: 28, paddingHorizontal: 18, paddingTop: 2 },
  groupTitle: {
    color: '#8C8C91',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2,
    paddingTop: 22,
  },
  compactGroupTitle: { fontSize: 12, paddingTop: 20, textTransform: 'uppercase' },
  row: {
    borderBottomColor: '#27272A',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 18,
  },
  compactRow: { paddingVertical: 14 },
  pressed: { opacity: 0.58 },
  title: { color: '#F4F4F5', fontSize: 16, fontWeight: '500', lineHeight: 22 },
  compactTitle: { fontSize: 15, lineHeight: 20 },
  metadata: { color: '#85858A', fontSize: 12, marginTop: 6 },
  compactMetadata: { fontSize: 11, marginTop: 4 },
});
