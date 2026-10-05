import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  MESSAGE_INPUT_MAX_HEIGHT,
  MESSAGE_INPUT_MIN_HEIGHT,
  messageInputHeight,
  messageInputScrollEnabled,
  messageSendEnabled,
} from '../src/features/home/message-composer-layout.ts';

test('the composer grows with wrapped content, caps its height, and then scrolls', () => {
  assert.equal(messageInputHeight(12), MESSAGE_INPUT_MIN_HEIGHT);
  assert.equal(messageInputHeight(67.2), 68);
  assert.equal(messageInputHeight(500), MESSAGE_INPUT_MAX_HEIGHT);
  assert.equal(messageInputHeight(Number.NaN), MESSAGE_INPUT_MIN_HEIGHT);
  assert.equal(messageInputScrollEnabled(68), false);
  assert.equal(messageInputScrollEnabled(MESSAGE_INPUT_MAX_HEIGHT), true);
});

test('send availability distinguishes empty, ready, and in-flight composer states', () => {
  const idle = {
    isFinishing: false,
    isResponding: false,
    isRestoring: false,
    isSavingMessage: false,
  };
  assert.equal(messageSendEnabled('', idle), false);
  assert.equal(messageSendEnabled('   ', idle), false);
  assert.equal(messageSendEnabled('Ready to send', idle), true);
  assert.equal(messageSendEnabled('No duplicate', { ...idle, isSavingMessage: true }), false);
  assert.equal(messageSendEnabled('Wait for Tina', { ...idle, isResponding: true }), false);
});

test('the shared composer measures controlled text independently of native input events', async () => {
  const [source, homeSource] = await Promise.all([
    readFile(new URL(
      '../src/features/home/message-composer.tsx',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../src/features/home/home-screen.tsx',
      import.meta.url,
    ), 'utf8'),
  ]);
  const inputStart = source.indexOf('<TextInput');
  const inputSource = source.slice(inputStart, source.indexOf('/>', inputStart));

  assert.match(source, /multiline/);
  assert.doesNotMatch(source, /numberOfLines=/);
  assert.match(source, /style=\{styles\.inputFrame\}/);
  assert.match(source, /style=\{styles\.inputSizer\}/);
  assert.match(source, /\{draft \|\| ' '\}/);
  assert.match(source, /onLayout=\{\(\{ nativeEvent \}\) => onInputHeightChange\(nativeEvent\.layout\.height\)\}/);
  assert.doesNotMatch(inputSource, /onContentSizeChange=/);
  assert.match(source, /minWidth: 0/);
  assert.match(source, /width: '100%'/);
  assert.match(source, /scrollEnabled=\{messageInputScrollEnabled\(inputHeight\)\}/);
  assert.match(source, /disabled=\{!canSend\}/);
  assert.match(source, /accessibilityState=\{\{ busy: isBusy, disabled: !canSend \}\}/);
  assert.match(source, /onPress=\{onSend\}/);
  assert.doesNotMatch(inputSource, /placeholder=/);
  assert.match(homeSource, /<KeyboardAvoidingView[\s\S]*behavior=\{KEYBOARD_AVOIDING_BEHAVIOR\}/);
  assert.match(homeSource, /keyboardVerticalOffset=\{0\}/);
});
