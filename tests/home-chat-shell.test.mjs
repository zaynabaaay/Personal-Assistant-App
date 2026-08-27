import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Home is a minimal dark conversation shell without the dashboard clock', async () => {
  const home = await read('../src/features/home/home-screen.tsx');
  assert.match(home, /backgroundColor: '#050505'/);
  assert.match(home, /<StatusBar style="light"/);
  assert.match(home, /<Text style=\{styles\.headerTitle\}>Tina<\/Text>/);
  assert.doesNotMatch(home, /TIME_FORMATTER|DATE_FORMATTER|useCurrentDate|styles\.time|styles\.date/);
});

test('New Chat presents the existing safe finalization lifecycle', async () => {
  const home = await read('../src/features/home/home-screen.tsx');
  assert.match(home, /\{isFinishing \? 'Saving…' : 'New Chat'\}/);
  assert.match(home, /onNewChat=\{finishConversation\}/);
  assert.match(home, /finishConversationLifecycle\(\{/);
  assert.match(home, /process: processCompletedConversation/);
  assert.match(home, /processMemory: processConversationMemory/);
  assert.match(home, /reset: resetActiveConversation/);
  assert.doesNotMatch(home, />Finish</);
});

test('the menu opens an overlay Chats drawer with outside-tap close and saved-chat navigation', async () => {
  const [home, drawer] = await Promise.all([
    read('../src/features/home/home-screen.tsx'),
    read('../src/features/home/chats-drawer.tsx'),
  ]);
  assert.match(home, /testID="open-chats-drawer"/);
  assert.match(home, /setDrawerOpen\(true\)/);
  assert.match(drawer, /testID="chats-drawer-backdrop"/);
  assert.match(drawer, /onPress=\{onClose\}/);
  assert.match(drawer, /PanResponder\.create/);
  assert.match(drawer, /<ChatsList compact/);
  assert.match(home, /pathname: '\/history\/\[id\]'/);
  assert.match(home, /router\.push\('\/history'/);
});

test('drawer state is an overlay sibling and cannot remount or clear the controlled composer', async () => {
  const [home, drawer, composerSource] = await Promise.all([
    read('../src/features/home/home-screen.tsx'),
    read('../src/features/home/chats-drawer.tsx'),
    read('../src/features/home/message-composer.tsx'),
  ]);
  const composer = home.indexOf('<MessageComposer');
  const drawerStart = home.indexOf('<ChatsDrawer', composer);
  const keyboardEnd = home.indexOf('</KeyboardAvoidingView>', drawerStart);
  assert.ok(composer > 0 && drawerStart > composer && keyboardEnd > drawerStart);
  assert.equal((home.match(/<MessageComposer/g) ?? []).length, 1);
  assert.doesNotMatch(drawer, /setDraft|resetComposer|setActiveConversation/);
  assert.match(composerSource, /value=\{draft\}/);
});

test('the composer has no prompt placeholder and preserves draft text across blur and refocus', async () => {
  const composer = await read('../src/features/home/message-composer.tsx');
  const inputStart = composer.indexOf('<TextInput');
  const input = composer.slice(inputStart, composer.indexOf('/>', inputStart));
  assert.doesNotMatch(composer, /Ask anything/);
  assert.doesNotMatch(input, /placeholder=/);
  assert.match(input, /value=\{draft\}/);
  assert.doesNotMatch(input, /onBlur=/);
  assert.doesNotMatch(composer, /isFocused|composerFocused|setIsFocused/);
  assert.equal((composer.match(/<TextInput/g) ?? []).length, 1);
});

test('send states are visual, disabled while unavailable, and guarded during requests', async () => {
  const [home, composer] = await Promise.all([
    read('../src/features/home/home-screen.tsx'),
    read('../src/features/home/message-composer.tsx'),
  ]);
  assert.match(home, /messageSendEnabled\(draft/);
  assert.match(composer, /disabled=\{!canSend\}/);
  assert.match(composer, /accessibilityState=\{\{ busy: isBusy, disabled: !canSend \}\}/);
  assert.match(composer, /sendButtonDisabled/);
  assert.match(home, /isBusy=\{isSavingMessage \|\| isResponding\}/);
  assert.match(home, /if \(!text \|\| isResponding \|\| isSavingMessage/);
});

test('Tina uses a reduced-motion-aware inline thinking indicator without status copy', async () => {
  const [home, reducedMotion] = await Promise.all([
    read('../src/features/home/home-screen.tsx'),
    read('../src/features/accessibility/use-reduced-motion.ts'),
  ]);
  assert.doesNotMatch(home, /Responding…/);
  assert.match(home, /testID="thinking-indicator"/);
  assert.match(home, /accessibilityLabel="Tina is thinking"/);
  assert.match(home, /Animated\.loop/);
  assert.match(reducedMotion, /isReduceMotionEnabled/);
});

test('keyboard, safe-area, active restoration, and Chats routes remain wired', async () => {
  const [home, composer, chats, detail] = await Promise.all([
    read('../src/features/home/home-screen.tsx'),
    read('../src/features/home/message-composer.tsx'),
    read('../src/app/history/index.tsx'),
    read('../src/app/history/[id].tsx'),
  ]);
  assert.match(home, /<SafeAreaView/);
  assert.match(home, /<KeyboardAvoidingView[\s\S]*behavior=\{KEYBOARD_AVOIDING_BEHAVIOR\}/);
  assert.match(home, /keyboardVerticalOffset=\{0\}/);
  assert.match(home, /keyboardView: \{ flex: 1, position: 'relative' \}/);
  assert.doesNotMatch(home, /<View style=\{styles\.shell\}>/);
  assert.match(home, /conversationService\.getActiveConversation\(\)/);
  assert.match(composer, /keyboardAppearance="dark"/);
  assert.match(chats, /<ChatsList/);
  assert.match(detail, /record\.conversation\.title/);
  assert.match(chats, /backgroundColor: '#050505'/);
  assert.match(detail, /backgroundColor: '#050505'/);
});
