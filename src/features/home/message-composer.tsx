import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  MESSAGE_INPUT_MAX_HEIGHT,
  MESSAGE_INPUT_MIN_HEIGHT,
  messageInputScrollEnabled,
} from './message-composer-layout';

export type MessageComposerProps = {
  canSend: boolean;
  draft: string;
  inputHeight: number;
  isBusy: boolean;
  isListening: boolean;
  onChangeText: (text: string) => void;
  onInputHeightChange: (height: number) => void;
  onSend: () => void;
  onToggleListening: () => void;
};

const TINA_ACCENT = '#8AB4F8';

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

export function MessageComposer({
  canSend,
  draft,
  inputHeight,
  isBusy,
  isListening,
  onChangeText,
  onInputHeightChange,
  onSend,
  onToggleListening,
}: MessageComposerProps) {
  return (
    <View style={styles.composerShell} testID="composer-shell">
      <View style={styles.composer}>
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
            keyboardAppearance="dark"
            maxLength={1000}
            multiline
            onChangeText={(text) => {
              onChangeText(text);
              if (text.length === 0) onInputHeightChange(MESSAGE_INPUT_MIN_HEIGHT);
            }}
            onFocus={() => {
              if (isListening) onToggleListening();
            }}
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
          accessibilityState={{ busy: isBusy, disabled: !canSend }}
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

const styles = StyleSheet.create({
  composerShell: { paddingBottom: 10, paddingHorizontal: 12, paddingTop: 4 },
  composer: {
    alignItems: 'flex-end',
    backgroundColor: '#19191B',
    borderColor: '#303034',
    borderRadius: 25,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 50,
    paddingBottom: 5,
    paddingLeft: 17,
    paddingRight: 5,
    paddingTop: 5,
  },
  input: {
    color: '#F7F7F8',
    fontSize: 16,
    lineHeight: 22,
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
  inputFrame: { flex: 1, minWidth: 0, position: 'relative' },
  inputSizer: {
    fontSize: 16,
    left: 0,
    lineHeight: 22,
    opacity: 0,
    paddingBottom: 8,
    paddingLeft: 0,
    paddingRight: 8,
    paddingTop: 8,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  inputWeb: { fontSize: 16 },
  controlButton: {
    alignItems: 'center',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  iconButtonActive: { backgroundColor: '#202B3A' },
  micIcon: { alignItems: 'center', height: 22, justifyContent: 'flex-start', width: 18 },
  micCapsule: {
    borderColor: '#8C8C91',
    borderRadius: 5,
    borderWidth: 1.5,
    height: 11,
    width: 7,
  },
  micCapsuleActive: { borderColor: TINA_ACCENT },
  micArc: {
    borderBottomColor: '#8C8C91',
    borderBottomLeftRadius: 7,
    borderBottomRightRadius: 7,
    borderBottomWidth: 1.5,
    borderLeftColor: '#8C8C91',
    borderLeftWidth: 1.5,
    borderRightColor: '#8C8C91',
    borderRightWidth: 1.5,
    height: 8,
    marginTop: -5,
    width: 13,
  },
  micArcActive: {
    borderBottomColor: TINA_ACCENT,
    borderLeftColor: TINA_ACCENT,
    borderRightColor: TINA_ACCENT,
  },
  micStem: { backgroundColor: '#8C8C91', height: 3, width: 1.5 },
  micStemActive: { backgroundColor: TINA_ACCENT },
  micBase: { backgroundColor: '#8C8C91', borderRadius: 1, height: 1.5, width: 7 },
  micBaseActive: { backgroundColor: TINA_ACCENT },
  sendButton: { backgroundColor: TINA_ACCENT, marginLeft: 3 },
  sendButtonDisabled: { backgroundColor: '#2B2B2E' },
  sendButtonPressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
  sendArrow: { color: '#08111F', fontSize: 22, fontWeight: '600', lineHeight: 24, marginTop: -2 },
  sendArrowDisabled: { color: '#626267' },
  pressed: { opacity: 0.55 },
});
