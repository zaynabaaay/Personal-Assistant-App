import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ConversationWithMessages } from '@/domain/conversations';
import { conversationService } from '@/services/conversations';

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export default function CompletedConversationScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const conversationId = Array.isArray(id) ? id[0] : id;
  const [record, setRecord] = useState<ConversationWithMessages | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const confirmDelete = () => {
    if (!record || deleting) return;
    Alert.alert(
      'Delete this chat?',
      'The transcript will be permanently removed. Tina’s structured memory will be kept.',
      [
        { style: 'cancel', text: 'Cancel' },
        {
          onPress: async () => {
            setDeleting(true);
            setDeleteError(null);
            try {
              await conversationService.deleteCompletedConversation(record.conversation.id);
              router.replace('/history');
            } catch {
              setDeleting(false);
              setDeleteError('This chat could not be deleted. Please try again.');
            }
          },
          style: 'destructive',
          text: 'Delete',
        },
      ],
    );
  };

  useEffect(() => {
    let active = true;

    if (!conversationId) {
      return () => undefined;
    }

    conversationService.getCompletedConversation(conversationId).then(
      (value) => {
        if (!active) return;
        if (value) setRecord(value);
        else setError('This conversation could not be found.');
      },
      () => {
        if (active) setError('This conversation could not be loaded. Please try again.');
      },
    ).finally(() => {
      if (active) setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [conversationId]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to Chats"
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={styles.back}>Back</Text>
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>Chats</Text>
        <View style={styles.headerSpacer} />
      </View>

      {!conversationId ? (
        <View style={styles.centered}>
          <Text accessibilityLiveRegion="assertive" style={styles.error}>
            This conversation could not be found.
          </Text>
        </View>
      ) : loading ? (
        <View style={styles.centered}><ActivityIndicator color="#8F8F95" /></View>
      ) : error || !record ? (
        <View style={styles.centered}>
          <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>{record.conversation.title}</Text>
          <Text style={styles.date}>
            {DATE_TIME_FORMATTER.format(new Date(record.conversation.completedAt))}
          </Text>
          {record.conversation.metadataStatus === 'generated' ? (
            <Text style={styles.summary}>{record.conversation.summary}</Text>
          ) : null}

          <View style={styles.transcript}>
            {record.messages.map((message) => (
              <View
                key={message.id}
                style={message.role === 'user' ? styles.userMessage : styles.assistantMessage}
              >
                <Text style={styles.role}>{message.role === 'user' ? 'You' : 'Tina'}</Text>
                <Text style={styles.messageText}>{message.content}</Text>
                <Text style={styles.messageTime}>
                  {DATE_TIME_FORMATTER.format(new Date(message.occurredAt))}
                </Text>
              </View>
            ))}
          </View>

          <Pressable
            accessibilityRole="button"
            disabled={deleting}
            onPress={confirmDelete}
            style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}
          >
            <Text style={styles.deleteText}>{deleting ? 'Deleting…' : 'Delete chat'}</Text>
          </Pressable>
          {deleteError ? (
            <Text accessibilityLiveRegion="assertive" style={styles.deleteError}>{deleteError}</Text>
          ) : null}
        </ScrollView>
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
  headerTitle: { color: '#F7F7F8', fontSize: 17, fontWeight: '600' },
  headerSpacer: { width: 32 },
  centered: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 32 },
  error: { color: '#E39A8E', fontSize: 14, textAlign: 'center' },
  content: { paddingBottom: 48, paddingHorizontal: 30, paddingTop: 18 },
  title: { color: '#F7F7F8', fontSize: 24, fontWeight: '600', lineHeight: 31 },
  date: { color: '#85858A', fontSize: 12, marginTop: 7 },
  summary: { color: '#B3B3B7', fontSize: 15, lineHeight: 22, marginTop: 16 },
  transcript: { marginTop: 34 },
  userMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#242426',
    borderRadius: 16,
    marginTop: 20,
    maxWidth: '82%',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  assistantMessage: { alignSelf: 'flex-start', marginTop: 24, maxWidth: '92%' },
  role: { color: '#85858A', fontSize: 11, fontWeight: '600', marginBottom: 4 },
  messageText: { color: '#F0F0F2', fontSize: 16, lineHeight: 24 },
  messageTime: { color: '#747479', fontSize: 10, marginTop: 6 },
  deleteButton: { alignSelf: 'center', marginTop: 46, padding: 12 },
  deleteText: { color: '#E58878', fontSize: 14 },
  deleteError: { color: '#E39A8E', fontSize: 13, textAlign: 'center' },
  pressed: { opacity: 0.55 },
});
