import { useEffect, useRef, useState } from 'react';
import { type Href, useRouter } from 'expo-router';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ActiveConversation, ConversationMessage } from '@/domain/conversations';
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
  MESSAGE_INPUT_MAX_HEIGHT,
  MESSAGE_INPUT_MIN_HEIGHT,
  messageInputHeight,
  messageInputScrollEnabled,
} from './message-composer-layout';
import { useVisibleViewport } from './use-visible-viewport';

type HomeHeaderProps = {
  onFinish: () => void;
  onOpenChats: () => void;
  isFinishing: boolean;
  showFinish: boolean;
};

type ConversationProps = {
  isResponding: boolean;
  messages: ConversationMessage[];
};

type MessageComposerProps = {
  canSend: boolean;
  draft: string;
  inputHeight: number;
  isFocused: boolean;
  isListening: boolean;
  onBlur: () => void;
  onChangeText: (text: string) => void;
  onFocus: () => void;
  onInputHeightChange: (height: number) => void;
  onSend: () => void;
  onToggleListening: () => void;
};

const MICROPHONE_ACTIVE_COLOR = '#8B5E52';
const KEYBOARD_AVOIDING_BEHAVIOR =
  Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined;
const WEB_HYDRATION_PROPS =
  Platform.OS === 'web' ? { suppressHydrationWarning: true } : {};
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'long',
  weekday: 'long',
});

function useCurrentDate() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return now;
}

function HomeHeader({
  isFinishing,
  onFinish,
  onOpenChats,
  showFinish,
}: HomeHeaderProps) {
  const now = useCurrentDate();

  return (
    <View style={styles.header} testID="home-header">
      <View>
        <Text {...WEB_HYDRATION_PROPS} style={styles.time}>
          {TIME_FORMATTER.format(now)}
        </Text>
        <Text {...WEB_HYDRATION_PROPS} style={styles.date}>
          {DATE_FORMATTER.format(now)}
        </Text>
      </View>

      <View style={styles.headerActions}>
        <Pressable
          accessibilityLabel="Open saved chats"
          accessibilityRole="button"
          hitSlop={10}
          onPress={onOpenChats}
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
        >
          <Text style={styles.headerButtonText}>Chats</Text>
        </Pressable>

        {showFinish ? (
          <Pressable
            accessibilityLabel="Finish conversation"
            accessibilityRole="button"
            disabled={isFinishing}
            hitSlop={10}
            onPress={onFinish}
            style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
          >
            <Text style={styles.finishText}>{isFinishing ? 'Saving…' : 'Finish'}</Text>
          </Pressable>
        ) : null}
      </View>
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

      {isResponding ? (
        <View style={styles.assistantMessage}>
          <Text accessibilityLiveRegion="polite" style={styles.assistantMessageText}>
            Responding…
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

function MicrophoneIcon({ active }: { active: boolean }) {
  return (
    <View style={styles.micIcon}>
      <View style={[styles.micCapsule, active && styles.micCapsuleActive]} />
      <View style={[styles.micArc, active && styles.micArcActive]} />
      <View style={[styles.micStem, active && styles.micStemActive]} />
      <View style={[styles.micBase, active && styles.micBaseActive]} />
    </View>
  );
}

function MessageComposer({
  canSend,
  draft,
  inputHeight,
  isFocused,
  isListening,
  onBlur,
  onChangeText,
  onFocus,
  onInputHeightChange,
  onSend,
  onToggleListening,
}: MessageComposerProps) {
  return (
    <View style={styles.composerShell} testID="composer-shell">
      {isListening ? <Text style={styles.listeningLabel}>Listening…</Text> : null}

      <View style={[styles.composer, isFocused && styles.composerFocused]}>
        <View style={styles.inputFrame}>
          <Text
            accessibilityElementsHidden
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            onLayout={({ nativeEvent }) => onInputHeightChange(nativeEvent.layout.height)}
            pointerEvents="none"
            style={styles.inputSizer}
          >
            {draft || ' '}
          </Text>
          <TextInput
            accessibilityLabel="Message"
            maxLength={1000}
            multiline
            onBlur={onBlur}
            onChangeText={(text) => {
              onChangeText(text);
              if (text.length === 0) onInputHeightChange(MESSAGE_INPUT_MIN_HEIGHT);
            }}
            onFocus={onFocus}
            placeholder={isListening ? 'Listening…' : 'Ask anything…'}
            placeholderTextColor="#8B8983"
            returnKeyType="default"
            scrollEnabled={messageInputScrollEnabled(inputHeight)}
            style={[
              styles.input,
              Platform.OS === 'web' && styles.inputWeb,
              { height: inputHeight },
            ]}
            testID="message-input"
            value={draft}
          />
        </View>

        <Pressable
          accessibilityLabel={isListening ? 'Stop listening' : 'Start voice input'}
          accessibilityRole="button"
          onPress={onToggleListening}
          style={({ pressed }) => [
            styles.controlButton,
            isListening && styles.iconButtonActive,
            pressed && styles.pressed,
          ]}
        >
          <MicrophoneIcon active={isListening} />
        </Pressable>

        <Pressable
          accessibilityLabel="Send message"
          accessibilityRole="button"
          disabled={!canSend}
          onPress={onSend}
          style={({ pressed }) => [
            styles.controlButton,
            styles.sendButton,
            !canSend && styles.sendButtonDisabled,
            pressed && canSend && styles.sendButtonPressed,
          ]}
        >
          <Text style={[styles.sendArrow, !canSend && styles.sendArrowDisabled]}>↑</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function HomeScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const visibleViewport = useVisibleViewport();
  const [draft, setDraft] = useState('');
  const [inputHeight, setInputHeight] = useState(MESSAGE_INPUT_MIN_HEIGHT);
  const [isFocused, setIsFocused] = useState(false);
  const [isListening, setIsListening] = useState(false);
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
  const canSend = draft.trim().length > 0 && !isResponding && !isFinishing &&
    !isRestoring && !isSavingMessage;

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
    setIsFocused(false);
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
      <KeyboardAvoidingView behavior={KEYBOARD_AVOIDING_BEHAVIOR} style={styles.keyboardView}>
        <HomeHeader
          isFinishing={isFinishing}
          onFinish={finishConversation}
          onOpenChats={() => router.push('/history' as Href)}
          showFinish={messages.length > 0 && !isResponding && !isSavingMessage &&
            !isRestoring && !persistenceError}
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
          isFocused={isFocused}
          isListening={isListening}
          onBlur={() => setIsFocused(false)}
          onChangeText={setDraft}
          onFocus={() => {
            setIsFocused(true);
            setIsListening(false);
          }}
          onInputHeightChange={(height) => setInputHeight(messageInputHeight(height))}
          onSend={sendMessage}
          onToggleListening={toggleListening}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F5F4F0',
    flex: 1,
  },
  safeAreaWeb: {
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    right: 0,
  },
  keyboardView: {
    flex: 1,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 30,
    paddingTop: 24,
  },
  time: {
    color: '#34332F',
    fontSize: 22,
    fontWeight: '500',
    letterSpacing: -0.5,
    lineHeight: 27,
  },
  date: {
    color: '#96938B',
    fontSize: 12,
    letterSpacing: 0.1,
    marginTop: 5,
  },
  headerActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  headerButton: {
    paddingHorizontal: 1,
    paddingVertical: 7,
  },
  headerButtonText: {
    color: '#908D85',
    fontSize: 12,
    letterSpacing: 0.1,
  },
  finishText: {
    color: '#625D55',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  finishError: {
    color: '#8B5E52',
    fontSize: 12,
    marginHorizontal: 30,
    marginTop: 16,
  },
  completionNotice: {
    color: '#65705D',
    fontSize: 12,
    marginHorizontal: 30,
    marginTop: 16,
  },
  persistenceNotice: {
    alignItems: 'flex-start',
  },
  retryText: {
    color: '#625D55',
    fontSize: 12,
    fontWeight: '600',
    marginHorizontal: 30,
    marginTop: 8,
  },
  conversation: {
    flex: 1,
    marginTop: 24,
  },
  conversationContent: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingBottom: 48,
    paddingHorizontal: 30,
    paddingTop: 64,
  },
  userMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#EAE8E3',
    borderRadius: 16,
    marginTop: 22,
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  userMessageText: {
    color: '#3D3B36',
    fontSize: 15,
    lineHeight: 21,
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    marginTop: 26,
    maxWidth: '90%',
  },
  assistantMessageText: {
    color: '#44423D',
    fontSize: 18,
    letterSpacing: -0.15,
    lineHeight: 28,
  },
  composerShell: {
    paddingBottom: 14,
    paddingHorizontal: 18,
  },
  listeningLabel: {
    color: '#8B6C62',
    fontSize: 12,
    marginBottom: 8,
    marginLeft: 14,
  },
  composer: {
    alignItems: 'flex-end',
    backgroundColor: '#FBFAF8',
    borderColor: '#E7E4DE',
    borderRadius: 25,
    borderWidth: StyleSheet.hairlineWidth,
    boxShadow: '0 2px 8px rgba(41, 39, 34, 0.035)',
    flexDirection: 'row',
    minHeight: 50,
    paddingBottom: 5,
    paddingLeft: 17,
    paddingRight: 5,
    paddingTop: 5,
  },
  composerFocused: {
    backgroundColor: '#FEFDFB',
    borderColor: '#D8D4CC',
  },
  input: {
    color: '#33312D',
    fontSize: 15,
    lineHeight: 21,
    maxHeight: MESSAGE_INPUT_MAX_HEIGHT,
    minHeight: MESSAGE_INPUT_MIN_HEIGHT,
    outlineColor: 'transparent',
    outlineStyle: 'solid',
    outlineWidth: 0,
    paddingBottom: 8,
    paddingLeft: 0,
    paddingRight: 8,
    paddingTop: 8,
    textAlignVertical: 'top',
    width: '100%',
  },
  inputFrame: {
    flex: 1,
    minWidth: 0,
    position: 'relative',
  },
  inputSizer: {
    fontSize: 15,
    left: 0,
    lineHeight: 21,
    opacity: 0,
    paddingBottom: 8,
    paddingLeft: 0,
    paddingRight: 8,
    paddingTop: 8,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  inputWeb: {
    fontSize: 16,
  },
  controlButton: {
    alignItems: 'center',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  iconButtonActive: {
    backgroundColor: '#F1E9E6',
  },
  micIcon: {
    alignItems: 'center',
    height: 22,
    justifyContent: 'flex-start',
    width: 18,
  },
  micCapsule: {
    borderColor: '#5F5D58',
    borderRadius: 5,
    borderWidth: 1.5,
    height: 11,
    width: 7,
  },
  micCapsuleActive: {
    borderColor: MICROPHONE_ACTIVE_COLOR,
  },
  micArc: {
    borderBottomColor: '#5F5D58',
    borderBottomLeftRadius: 7,
    borderBottomRightRadius: 7,
    borderBottomWidth: 1.5,
    borderLeftColor: '#5F5D58',
    borderLeftWidth: 1.5,
    borderRightColor: '#5F5D58',
    borderRightWidth: 1.5,
    height: 8,
    marginTop: -5,
    width: 13,
  },
  micArcActive: {
    borderBottomColor: MICROPHONE_ACTIVE_COLOR,
    borderLeftColor: MICROPHONE_ACTIVE_COLOR,
    borderRightColor: MICROPHONE_ACTIVE_COLOR,
  },
  micStem: {
    backgroundColor: '#5F5D58',
    height: 3,
    width: 1.5,
  },
  micStemActive: {
    backgroundColor: MICROPHONE_ACTIVE_COLOR,
  },
  micBase: {
    backgroundColor: '#5F5D58',
    borderRadius: 1,
    height: 1.5,
    width: 7,
  },
  micBaseActive: {
    backgroundColor: MICROPHONE_ACTIVE_COLOR,
  },
  sendButton: {
    backgroundColor: '#D2CEC6',
    marginLeft: 3,
  },
  sendButtonDisabled: {
    backgroundColor: '#ECE9E3',
  },
  sendButtonPressed: {
    backgroundColor: '#C5C0B7',
    transform: [{ scale: 0.96 }],
  },
  sendArrow: {
    color: '#4E4B45',
    fontSize: 22,
    fontWeight: '500',
    lineHeight: 24,
    marginTop: -2,
  },
  sendArrowDisabled: {
    color: '#AAA69E',
  },
  pressed: {
    opacity: 0.55,
  },
});
