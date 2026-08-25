import { useCallback, useState } from 'react';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CompletedConversation } from '@/domain/conversations';
import { chatMetadata, groupChats } from '@/features/chats/chat-presentation';
import { conversationService } from '@/services/conversations';

export default function ChatsScreen() {
  const router = useRouter();
  const [conversations, setConversations] = useState<CompletedConversation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);

    conversationService.listCompletedConversations().then(
      (values) => {
        if (active) setConversations(values);
      },
      () => {
        if (active) setError('Chats could not be loaded. Please try again.');
      },
    ).finally(() => {
      if (active) setLoading(false);
    });

    return () => {
      active = false;
    };
  }, []));

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to Home"
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={styles.back}>Back</Text>
        </Pressable>
        <Text style={styles.heading}>Chats</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#77736B" />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text>
        </View>
      ) : conversations.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>No saved chats yet</Text>
          <Text style={styles.emptyBody}>Chats you finish will appear here.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {groupChats(conversations).map((group) => (
            <View key={group.title}>
              <Text style={styles.groupTitle}>{group.title}</Text>
              {group.conversations.map((conversation) => (
                <Pressable
                  accessibilityHint={chatMetadata(conversation)}
                  accessibilityRole="button"
                  key={conversation.id}
                  onPress={() => router.push({
                    pathname: '/history/[id]',
                    params: { id: conversation.id },
                  } as unknown as Href)}
                  style={({ pressed }) => [styles.card, pressed && styles.pressed]}
                >
                  <Text numberOfLines={2} style={styles.title}>{conversation.title}</Text>
                  <Text style={styles.metadata}>{chatMetadata(conversation)}</Text>
                </Pressable>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#F5F4F0', flex: 1 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 18,
  },
  back: { color: '#716D65', fontSize: 14 },
  heading: { color: '#34332F', fontSize: 19, fontWeight: '600' },
  headerSpacer: { width: 32 },
  centered: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 32 },
  error: { color: '#8B5E52', fontSize: 14, textAlign: 'center' },
  emptyTitle: { color: '#45423C', fontSize: 17, fontWeight: '500' },
  emptyBody: { color: '#8B8983', fontSize: 14, marginTop: 8 },
  list: { paddingBottom: 32, paddingHorizontal: 24, paddingTop: 8 },
  groupTitle: {
    color: '#716D65',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2,
    paddingTop: 22,
  },
  card: {
    borderBottomColor: '#DFDCD5',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 18,
  },
  pressed: { opacity: 0.55 },
  title: { color: '#3D3B36', fontSize: 16, fontWeight: '500', lineHeight: 22 },
  metadata: { color: '#96938B', fontSize: 12, marginTop: 6 },
});
