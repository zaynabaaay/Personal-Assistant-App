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

type Message = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
};

const ASSISTANT_RESPONSE = 'Assistant response will appear here.';

function formatTime(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(value);
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(value);
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

export default function HomeScreen() {
  const [now, setNow] = useState(() => new Date());
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isListening, setIsListening] = useState(false);
  const nextMessageId = useRef(1);
  const conversationRef = useRef<ScrollView>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const sendMessage = () => {
    const text = draft.trim();

    if (!text) {
      return;
    }

    const userMessage: Message = {
      id: nextMessageId.current++,
      role: 'user',
      text,
    };
    const assistantMessage: Message = {
      id: nextMessageId.current++,
      role: 'assistant',
      text: ASSISTANT_RESPONSE,
    };

    setMessages((current) => [...current, userMessage, assistantMessage]);
    setDraft('');
    setIsListening(false);
  };

  const clearConversation = () => {
    setMessages([]);
    setDraft('');
    setIsListening(false);
    Keyboard.dismiss();
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardView}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.time}>{formatTime(now)}</Text>
            <Text style={styles.date}>{formatDate(now)}</Text>
          </View>

          {messages.length > 0 ? (
            <Pressable
              accessibilityLabel="Clear conversation"
              accessibilityRole="button"
              hitSlop={12}
              onPress={clearConversation}
              style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}
            >
              <Text style={styles.clearText}>Clear</Text>
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          contentContainerStyle={styles.conversationContent}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => conversationRef.current?.scrollToEnd({ animated: true })}
          ref={conversationRef}
          showsVerticalScrollIndicator={false}
          style={styles.conversation}
        >
          {messages.map((message) => (
            <View
              key={message.id}
              style={message.role === 'user' ? styles.userMessage : styles.assistantMessage}
            >
              <Text
                style={message.role === 'user' ? styles.userMessageText : styles.assistantMessageText}
              >
                {message.text}
              </Text>
            </View>
          ))}
        </ScrollView>

        <View style={styles.composerShell}>
          {isListening ? <Text style={styles.listeningLabel}>Listening…</Text> : null}

          <View style={styles.composer}>
            <TextInput
              accessibilityLabel="Message"
              maxLength={1000}
              multiline
              onChangeText={setDraft}
              onFocus={() => setIsListening(false)}
              placeholder={isListening ? 'Listening…' : 'Ask anything…'}
              placeholderTextColor="#8B8983"
              returnKeyType="default"
              style={styles.input}
              value={draft}
            />

            <Pressable
              accessibilityLabel={isListening ? 'Stop listening' : 'Start voice input'}
              accessibilityRole="button"
              onPress={() => {
                Keyboard.dismiss();
                setIsListening((current) => !current);
              }}
              style={({ pressed }) => [
                styles.iconButton,
                isListening && styles.iconButtonActive,
                pressed && styles.pressed,
              ]}
            >
              <MicrophoneIcon active={isListening} />
            </Pressable>

            <Pressable
              accessibilityLabel="Send message"
              accessibilityRole="button"
              disabled={!draft.trim()}
              onPress={sendMessage}
              style={({ pressed }) => [
                styles.sendButton,
                !draft.trim() && styles.sendButtonDisabled,
                pressed && draft.trim() && styles.sendButtonPressed,
              ]}
            >
              <Text style={styles.sendArrow}>↑</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F5F4F0',
    flex: 1,
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
  input: {
    color: '#33312D',
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
    maxHeight: 120,
    minHeight: 39,
    paddingRight: 8,
    paddingTop: 8,
    textAlignVertical: 'top',
  },
  iconButton: {
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
    borderColor: '#8B5E52',
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
    borderBottomColor: '#8B5E52',
    borderLeftColor: '#8B5E52',
    borderRightColor: '#8B5E52',
  },
  micStem: {
    backgroundColor: '#5F5D58',
    height: 3,
    width: 1.5,
  },
  micStemActive: {
    backgroundColor: '#8B5E52',
  },
  micBase: {
    backgroundColor: '#5F5D58',
    borderRadius: 1,
    height: 1.5,
    width: 7,
  },
  micBaseActive: {
    backgroundColor: '#8B5E52',
  },
  sendButton: {
    alignItems: 'center',
    backgroundColor: '#36342F',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    marginLeft: 3,
    width: 40,
  },
  sendButtonDisabled: {
    backgroundColor: '#DDDAD4',
  },
  sendButtonPressed: {
    backgroundColor: '#4A4842',
    transform: [{ scale: 0.96 }],
  },
  sendArrow: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '500',
    lineHeight: 24,
    marginTop: -2,
  },
  pressed: {
    opacity: 0.55,
  },
});
