import { useEffect, useRef, useState } from 'react';
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

import { assistantService } from '@/services/assistant/assistant-service';

import { useVisibleViewport } from './use-visible-viewport';

type Message = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
};

type HomeHeaderProps = {
  onClear: () => void;
  showClear: boolean;
};

type ConversationProps = {
  isResponding: boolean;
  messages: Message[];
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

const INPUT_MIN_HEIGHT = 39;
const INPUT_MAX_HEIGHT = 108;
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

function HomeHeader({ onClear, showClear }: HomeHeaderProps) {
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

      {showClear ? (
        <Pressable
          accessibilityLabel="Clear conversation"
          accessibilityRole="button"
          hitSlop={12}
          onPress={onClear}
          style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}
        >
          <Text style={styles.clearText}>Clear</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function MessageItem({ message }: { message: Message }) {
  const isUser = message.role === 'user';

  return (
    <View style={isUser ? styles.userMessage : styles.assistantMessage}>
      <Text style={isUser ? styles.userMessageText : styles.assistantMessageText}>
        {message.text}
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
        <TextInput
          accessibilityLabel="Message"
          maxLength={1000}
          multiline
          onBlur={onBlur}
          onChangeText={onChangeText}
          onContentSizeChange={({ nativeEvent }) =>
            onInputHeightChange(nativeEvent.contentSize.height)
          }
          onFocus={onFocus}
          placeholder={isListening ? 'Listening…' : 'Ask anything…'}
          placeholderTextColor="#8B8983"
          returnKeyType="default"
          scrollEnabled={inputHeight >= INPUT_MAX_HEIGHT}
          style={[
            styles.input,
            Platform.OS === 'web' && styles.inputWeb,
            { height: inputHeight },
          ]}
          value={draft}
        />

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
  const visibleViewport = useVisibleViewport();
  const [draft, setDraft] = useState('');
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_HEIGHT);
  const [isFocused, setIsFocused] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const nextMessageId = useRef(1);
  const activeRequestId = useRef(0);
  const canSend = draft.trim().length > 0 && !isResponding;

  useEffect(() => () => assistantService.cancelRequest(), []);

  const resetComposer = () => {
    setDraft('');
    setInputHeight(INPUT_MIN_HEIGHT);
    setIsListening(false);
  };

  const sendMessage = async () => {
    const text = draft.trim();

    if (!text || isResponding) {
      return;
    }

    const userMessage: Message = {
      id: nextMessageId.current++,
      role: 'user',
      text,
    };
    const conversation = [...messages, userMessage];
    const requestId = ++activeRequestId.current;

    setMessages(conversation);
    resetComposer();
    setIsResponding(true);

    const result = await assistantService.respond(
      conversation.map((message) => ({ content: message.text, role: message.role })),
    );

    if (activeRequestId.current !== requestId) {
      return;
    }

    if (result.status === 'success') {
      setMessages((current) => [
        ...current,
        {
          id: nextMessageId.current++,
          role: result.message.role,
          text: result.message.content,
        },
      ]);
    }

    setIsResponding(false);
  };

  const clearConversation = () => {
    activeRequestId.current += 1;
    assistantService.resetSession();
    setMessages([]);
    resetComposer();
    setIsFocused(false);
    setIsResponding(false);
    Keyboard.dismiss();
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
        <HomeHeader onClear={clearConversation} showClear={messages.length > 0} />
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
          onInputHeightChange={(height) =>
            setInputHeight(
              Math.min(INPUT_MAX_HEIGHT, Math.max(INPUT_MIN_HEIGHT, Math.ceil(height))),
            )
          }
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
  clearButton: {
    paddingHorizontal: 2,
    paddingVertical: 7,
  },
  clearText: {
    color: '#908D85',
    fontSize: 12,
    letterSpacing: 0.1,
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
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
    maxHeight: INPUT_MAX_HEIGHT,
    minHeight: INPUT_MIN_HEIGHT,
    outlineColor: 'transparent',
    outlineStyle: 'solid',
    outlineWidth: 0,
    paddingRight: 8,
    paddingTop: 8,
    textAlignVertical: 'top',
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
