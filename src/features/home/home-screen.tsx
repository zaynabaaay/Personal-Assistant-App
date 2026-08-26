import { useEffect, useRef, useState } from 'react';
import { type Href, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ActiveConversation, ConversationMessage } from '@/domain/conversations';
import { useReducedMotion } from '@/features/accessibility/use-reduced-motion';
import { useAuth } from '@/features/auth/auth-provider';
import { assistantService } from '@/services/assistant/assistant-service';
import {
  activeConversationOutbox,
  conversationService,
  createActiveConversation,
  createConversationMessageId,
  finishConversationLifecycle,
  processCompletedConversation,
} from '@/services/conversations';
import { processConversationMemory } from '@/services/memory';

import {
  MESSAGE_INPUT_MIN_HEIGHT,
  messageInputHeight,
  messageSendEnabled,
} from './message-composer-layout';
import { ChatsDrawer } from './chats-drawer';
import { MessageComposer } from './message-composer';
import { useVisibleViewport } from './use-visible-viewport';

type HomeHeaderProps = {
  canStartNewChat: boolean;
  isFinishing: boolean;
  onNewChat: () => void;
  onOpenDrawer: () => void;
};

type ConversationProps = {
  isResponding: boolean;
  messages: ConversationMessage[];
};

const TINA_ACCENT = '#8AB4F8';
const KEYBOARD_AVOIDING_BEHAVIOR =
  Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined;
function HomeHeader({
  canStartNewChat,
  isFinishing,
  onNewChat,
  onOpenDrawer,
}: HomeHeaderProps) {
  return (
    <View style={styles.header} testID="home-header">
      <Pressable
        accessibilityLabel="Open Chats drawer"
        accessibilityRole="button"
        hitSlop={10}
        onPress={onOpenDrawer}
        style={({ pressed }) => [styles.headerIconButton, pressed && styles.pressed]}
        testID="open-chats-drawer"
      >
        <View style={styles.menuIcon}>
          <View style={styles.menuLine} />
          <View style={[styles.menuLine, styles.menuLineShort]} />
        </View>
      </Pressable>

      <Text style={styles.headerTitle}>Tina</Text>

      <Pressable
        accessibilityLabel="Start a new chat"
        accessibilityRole="button"
        disabled={!canStartNewChat}
        hitSlop={8}
        onPress={onNewChat}
        style={({ pressed }) => [styles.newChatButton, pressed && canStartNewChat && styles.pressed]}
        testID="new-chat-button"
      >
        <Text style={[styles.newChatText, !canStartNewChat && styles.newChatTextDisabled]}>
          {isFinishing ? 'Saving…' : 'New Chat'}
        </Text>
      </Pressable>
    </View>
  );
}

function MessageItem({ message }: { message: ConversationMessage }) {
  const isUser = message.role === 'user';

  return (
    <View style={isUser ? styles.userMessage : styles.assistantMessage}>
      <Text style={isUser ? styles.userMessageText : styles.assistantMessageText}>
        {message.content}
      </Text>
    </View>
  );
}

function Conversation({ isResponding, messages }: ConversationProps) {
  const scrollViewRef = useRef<ScrollView>(null);

  return (
    <ScrollView
      contentContainerStyle={styles.conversationContent}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
      ref={scrollViewRef}
      showsVerticalScrollIndicator={false}
      style={styles.conversation}
      testID="conversation-scroll"
    >
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}

      {isResponding ? <ThinkingIndicator /> : null}
    </ScrollView>
  );
}

function ThinkingIndicator() {
  const [progress] = useState(() => new Animated.Value(0));
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) {
      progress.setValue(0.5);
      return;
    }
    const animation = Animated.loop(Animated.timing(progress, {
      duration: 1050,
      toValue: 1,
      useNativeDriver: true,
    }));
    animation.start();
    return () => animation.stop();
  }, [progress, reducedMotion]);

  return (
    <View
      accessibilityLabel="Tina is thinking"
      accessibilityLiveRegion="polite"
      style={styles.thinkingIndicator}
      testID="thinking-indicator"
    >
      {[0, 1, 2].map((index) => (
        <Animated.View
          key={index}
          style={[
            styles.thinkingDot,
            {
              opacity: reducedMotion ? 0.55 : progress.interpolate({
                inputRange: [0, 0.08 + index * 0.18, 0.38 + index * 0.18, 1],
                outputRange: [0.25, 0.25, 0.9, 0.25],
              }),
            },
          ]}
        />
      ))}
    </View>
  );
}

export default function HomeScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const visibleViewport = useVisibleViewport();
  const [draft, setDraft] = useState('');
  const [inputHeight, setInputHeight] = useState(MESSAGE_INPUT_MIN_HEIGHT);
  const [isListening, setIsListening] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);
  const [isSavingMessage, setIsSavingMessage] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [pendingPersistenceKind, setPendingPersistenceKind] =
    useState<'assistant' | 'user' | null>(null);
  const [pendingUserMessage, setPendingUserMessage] = useState<ConversationMessage | null>(null);
  const [completionNotice, setCompletionNotice] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] = useState<ActiveConversation>(() =>
    createActiveConversation()
  );
  const activeRequestId = useRef(0);
  const messages = activeConversation.messages;
  const canSend = messageSendEnabled(draft, {
    isFinishing,
    isResponding,
    isRestoring,
    isSavingMessage,
  });
  const canStartNewChat = messages.length > 0 && !isResponding && !isFinishing &&
    !isSavingMessage && !isRestoring && !persistenceError;

  useEffect(() => {
    let mounted = true;
    const userId = user?.id;
    assistantService.resetSession();

    const restoreConversation = async () => {
      // Defer state synchronization until after the effect has subscribed. This
      // also lets cleanup cancel an obsolete account restore before it renders.
      await Promise.resolve();
      if (!mounted) return;
      setIsRestoring(true);
      setPersistenceError(null);
      setPendingPersistenceKind(null);
      setPendingUserMessage(null);
      setDraft('');

      if (!userId) {
        setActiveConversation(createActiveConversation());
        setIsRestoring(false);
        return;
      }

      try {
        const [stored, pending] = await Promise.all([
          conversationService.getActiveConversation(),
          activeConversationOutbox.load(userId),
        ]);
        if (!mounted) return;
        if (!pending) {
          setActiveConversation(stored ?? createActiveConversation());
          // A no-preference drain also discovers unfinished completed
          // conversations after a prior bounded Finish drain exhausted itself.
          void processConversationMemory(stored?.id).catch(() => undefined);
          return;
        }

        try {
          const restored = await conversationService.saveActiveConversation(pending);
          await activeConversationOutbox.clear(userId);
          if (mounted) {
            setActiveConversation(restored);
            void processConversationMemory(restored.id).catch(() => undefined);
          }
        } catch {
          const latest = await conversationService.getActiveConversation().catch(() => stored);
          if (!mounted) return;
          setActiveConversation(latest ?? createActiveConversation());
          const firstUnsaved = pending.messages[(latest?.messages.length ?? 0)];
          if (firstUnsaved?.role === 'user') {
            setDraft(firstUnsaved.content);
            setPendingUserMessage(firstUnsaved);
            setPendingPersistenceKind('user');
          } else {
            setPendingPersistenceKind('assistant');
          }
          setPersistenceError(
            'Conversation saving was interrupted. Your pending message is preserved for retry.',
          );
        }
      } catch {
        if (mounted) {
          setPersistenceError('The saved conversation could not be restored. Please try again.');
        }
      } finally {
        if (mounted) setIsRestoring(false);
      }
    };

    void restoreConversation();

    return () => {
      mounted = false;
      assistantService.cancelRequest();
    };
  }, [user?.id]);

  const resetComposer = () => {
    setDraft('');
    setInputHeight(MESSAGE_INPUT_MIN_HEIGHT);
    setIsListening(false);
  };

  const persistActiveConversation = async (conversation: ActiveConversation) => {
    if (!user?.id) throw new Error('Authentication is required.');
    await activeConversationOutbox.save(user.id, conversation);
    const persisted = await conversationService.saveActiveConversation(conversation);
    await activeConversationOutbox.clear(user.id);
    return persisted;
  };

  const persistAssistantReply = async (
    conversation: ActiveConversation,
    reply: ConversationMessage,
  ) => {
    const next = {
      ...conversation,
      messages: [...conversation.messages, reply],
      revision: conversation.messages.length + 1,
      updatedAt: reply.occurredAt,
    };
    setPendingPersistenceKind('assistant');
    try {
      const persisted = await persistActiveConversation(next);
      setActiveConversation(persisted);
      setPersistenceError(null);
      setPendingPersistenceKind(null);
    } catch {
      setPersistenceError(
        'Tina replied, but saving was interrupted. The reply is preserved; retry saving.',
      );
    }
  };

  const sendMessage = async () => {
    const text = draft.trim();

    if (!text || isResponding || isSavingMessage || isRestoring || !user?.id) {
      return;
    }

    const occurredAt = pendingUserMessage?.content === text &&
      pendingUserMessage.conversationId === activeConversation.id
      ? pendingUserMessage.occurredAt
      : new Date().toISOString();
    const userMessage: ConversationMessage = {
      content: text,
      conversationId: activeConversation.id,
      id: pendingUserMessage?.content === text &&
        pendingUserMessage.conversationId === activeConversation.id
        ? pendingUserMessage.id
        : createConversationMessageId(activeConversation.id),
      occurredAt,
      position: messages.length,
      role: 'user',
    };
    const nextConversation: ActiveConversation = {
      ...activeConversation,
      messages: [...messages, userMessage],
      revision: messages.length + 1,
      updatedAt: occurredAt,
    };
    const requestId = ++activeRequestId.current;

    setIsSavingMessage(true);
    setPendingPersistenceKind('user');
    setFinishError(null);
    setCompletionNotice(null);
    setPersistenceError(null);

    let persistedUserConversation: ActiveConversation;
    try {
      persistedUserConversation = await persistActiveConversation(nextConversation);
    } catch {
      const latest = await conversationService.getActiveConversation().catch(() => null);
      const savedMessage = latest?.messages.find((message) => message.id === userMessage.id);
      if (latest?.id === activeConversation.id && savedMessage?.content === userMessage.content) {
        persistedUserConversation = latest;
        await activeConversationOutbox.clear(user.id).catch(() => undefined);
      } else {
        if (latest?.id === activeConversation.id) setActiveConversation(latest);
        setPendingUserMessage(userMessage);
        setPersistenceError('Message was not saved. It is preserved; tap Send to retry.');
        setIsSavingMessage(false);
        return;
      }
    }

    setActiveConversation(persistedUserConversation);
    setPendingUserMessage(null);
    setPendingPersistenceKind(null);
    resetComposer();
    setIsSavingMessage(false);

    // Memory extraction is independent of response generation. The message is
    // already durable, so a failure here can be retried on restore or Finish.
    void processConversationMemory(persistedUserConversation.id).catch(() => undefined);

    if (persistedUserConversation.messages.at(-1)?.id !== userMessage.id) {
      return;
    }
    setIsResponding(true);

    const result = await assistantService.respond(
      persistedUserConversation.messages.map((message) => ({
        content: message.content,
        role: message.role,
      })),
    );

    if (activeRequestId.current !== requestId) {
      return;
    }

    if (result.status === 'success') {
      const reply: ConversationMessage = {
        content: result.message.content,
        conversationId: persistedUserConversation.id,
        id: createConversationMessageId(persistedUserConversation.id),
        occurredAt: new Date().toISOString(),
        position: persistedUserConversation.messages.length,
        role: result.message.role,
      };
      await persistAssistantReply(persistedUserConversation, reply);
    }

    setIsResponding(false);
  };

  const resetActiveConversation = () => {
    activeRequestId.current += 1;
    assistantService.resetSession();
    setActiveConversation(createActiveConversation());
    setPendingUserMessage(null);
    setPendingPersistenceKind(null);
    setPersistenceError(null);
    if (user?.id) void activeConversationOutbox.clear(user.id);
    resetComposer();
    setIsResponding(false);
    Keyboard.dismiss();
  };

  const retryPendingPersistence = async () => {
    if (!user?.id || isSavingMessage) return;
    setIsSavingMessage(true);
    try {
      const pending = await activeConversationOutbox.load(user.id);
      if (!pending) throw new Error('No pending conversation was found.');
      const persisted = await conversationService.saveActiveConversation(pending);
      await activeConversationOutbox.clear(user.id);
      setActiveConversation(persisted);
      setPersistenceError(null);
      setPendingPersistenceKind(null);
    } catch {
      setPersistenceError('Conversation saving is still unavailable. Your pending reply is preserved.');
    } finally {
      setIsSavingMessage(false);
    }
  };

  const finishConversation = async () => {
    if (
      messages.length === 0 || isResponding || isFinishing || isSavingMessage ||
      isRestoring || persistenceError
    ) return;

    setIsFinishing(true);
    setFinishError(null);
    setCompletionNotice(null);

    try {
      const result = await finishConversationLifecycle({
        active: activeConversation,
        onPersisted: () => setCompletionNotice('Conversation saved to Chats.'),
        process: processCompletedConversation,
        processMemory: processConversationMemory,
        reset: resetActiveConversation,
        service: conversationService,
      });
      if (result.processingStatus === 'processing') {
        setCompletionNotice(
          'Conversation saved to Chats. Project organization is still in progress.',
        );
      } else if (result.processingStatus === 'failed') {
        setCompletionNotice(
          'Conversation saved to Chats. Project organization could not finish yet and can be retried.',
        );
      }
    } catch {
      setFinishError('Conversation could not be saved. Nothing was cleared; please try again.');
    } finally {
      setIsFinishing(false);
    }
  };

  const toggleListening = () => {
    Keyboard.dismiss();
    setIsListening((current) => !current);
  };

  return (
    <SafeAreaView
      style={[
        styles.safeArea,
        visibleViewport && styles.safeAreaWeb,
        visibleViewport && { height: visibleViewport.height, top: visibleViewport.top },
      ]}
      testID="home-screen"
    >
      <StatusBar style="light" />
      <KeyboardAvoidingView
        behavior={KEYBOARD_AVOIDING_BEHAVIOR}
        keyboardVerticalOffset={0}
        style={styles.keyboardView}
        testID="home-keyboard-layout"
      >
        <HomeHeader
          canStartNewChat={canStartNewChat}
          isFinishing={isFinishing}
          onNewChat={finishConversation}
          onOpenDrawer={() => {
            Keyboard.dismiss();
            setDrawerOpen(true);
          }}
        />
        {finishError ? (
          <Text accessibilityLiveRegion="assertive" style={styles.finishError}>
            {finishError}
          </Text>
        ) : null}
        {completionNotice ? (
          <Text accessibilityLiveRegion="polite" style={styles.completionNotice}>
            {completionNotice}
          </Text>
        ) : null}
        {isRestoring ? (
          <Text accessibilityLiveRegion="polite" style={styles.completionNotice}>
            Restoring conversation…
          </Text>
        ) : null}
        {persistenceError ? (
          <View style={styles.persistenceNotice}>
            <Text accessibilityLiveRegion="assertive" style={styles.finishError}>
              {persistenceError}
            </Text>
            {pendingPersistenceKind === 'assistant' ? (
              <Pressable
                accessibilityLabel="Retry saving conversation"
                accessibilityRole="button"
                disabled={isSavingMessage}
                onPress={retryPendingPersistence}
              >
                <Text style={styles.retryText}>{isSavingMessage ? 'Retrying…' : 'Retry saving'}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <Conversation isResponding={isResponding} messages={messages} />
        <MessageComposer
          canSend={canSend}
          draft={draft}
          inputHeight={inputHeight}
          isBusy={isSavingMessage || isResponding}
          isListening={isListening}
          onChangeText={setDraft}
          onInputHeightChange={(height) => setInputHeight(messageInputHeight(height))}
          onSend={sendMessage}
          onToggleListening={toggleListening}
        />
        <ChatsDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onOpenFullChats={() => {
            setDrawerOpen(false);
            router.push('/history' as Href);
          }}
          onSelectChat={(conversationId) => {
            setDrawerOpen(false);
            router.push({
              pathname: '/history/[id]',
              params: { id: conversationId },
            } as unknown as Href);
          }}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#050505', flex: 1 },
  safeAreaWeb: {
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    right: 0,
  },
  keyboardView: { flex: 1, position: 'relative' },
  header: {
    alignItems: 'center',
    borderBottomColor: '#171719',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 54,
    paddingHorizontal: 12,
  },
  headerIconButton: { alignItems: 'center', height: 44, justifyContent: 'center', width: 44 },
  menuIcon: { gap: 6, width: 20 },
  menuLine: { backgroundColor: '#E8E8EA', borderRadius: 1, height: 1.5, width: 20 },
  menuLineShort: { width: 14 },
  headerTitle: { color: '#F7F7F8', fontSize: 17, fontWeight: '600', letterSpacing: -0.2 },
  newChatButton: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 72,
    paddingHorizontal: 4,
  },
  newChatText: { color: TINA_ACCENT, fontSize: 13, fontWeight: '600' },
  newChatTextDisabled: { color: '#55555A' },
  finishError: { color: '#E39A8E', fontSize: 12, marginHorizontal: 22, marginTop: 12 },
  completionNotice: { color: '#8F9A88', fontSize: 12, marginHorizontal: 22, marginTop: 12 },
  persistenceNotice: { alignItems: 'flex-start' },
  retryText: {
    color: '#B8B8BC',
    fontSize: 12,
    fontWeight: '600',
    marginHorizontal: 22,
    marginTop: 8,
  },
  conversation: { flex: 1 },
  conversationContent: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingBottom: 28,
    paddingHorizontal: 20,
    paddingTop: 24,
  },
  userMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#242426',
    borderRadius: 18,
    marginTop: 20,
    maxWidth: '82%',
    paddingHorizontal: 15,
    paddingVertical: 10,
  },
  userMessageText: { color: '#F4F4F5', fontSize: 16, lineHeight: 23 },
  assistantMessage: { alignSelf: 'flex-start', marginTop: 25, maxWidth: '94%' },
  assistantMessageText: {
    color: '#F4F4F5',
    fontSize: 17,
    letterSpacing: -0.1,
    lineHeight: 27,
  },
  thinkingIndicator: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 5,
    height: 28,
    marginTop: 22,
    paddingHorizontal: 2,
  },
  thinkingDot: { backgroundColor: '#929297', borderRadius: 3, height: 6, width: 6 },
  pressed: { opacity: 0.55 },
});
