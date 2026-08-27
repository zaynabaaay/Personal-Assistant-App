import { useCallback, useState } from 'react';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CompletedConversation } from '@/domain/conversations';
import { ChatsList } from '@/features/chats/chats-list';
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
      <StatusBar style="light" />
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
        <ChatsList
          conversations={conversations}
          onSelectChat={(conversationId) => router.push({
            pathname: '/history/[id]',
            params: { id: conversationId },
          } as unknown as Href)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#050505', flex: 1 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 18,
  },
  back: { color: '#A1A1A6', fontSize: 14 },
  heading: { color: '#F7F7F8', fontSize: 19, fontWeight: '600' },
  headerSpacer: { width: 32 },
  centered: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 32 },
  error: { color: '#E39A8E', fontSize: 14, textAlign: 'center' },
  emptyTitle: { color: '#F0F0F2', fontSize: 17, fontWeight: '500' },
  emptyBody: { color: '#85858A', fontSize: 14, marginTop: 8 },
});
