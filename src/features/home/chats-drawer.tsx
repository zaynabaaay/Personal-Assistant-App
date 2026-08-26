import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import type { CompletedConversation } from '@/domain/conversations';
import { useReducedMotion } from '@/features/accessibility/use-reduced-motion';
import { ChatsList } from '@/features/chats/chats-list';
import { conversationService } from '@/services/conversations';

type ChatsDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  onOpenFullChats: () => void;
  onSelectChat: (conversationId: string) => void;
};

export function ChatsDrawer({
  isOpen,
  onClose,
  onOpenFullChats,
  onSelectChat,
}: ChatsDrawerProps) {
  const { width: viewportWidth } = useWindowDimensions();
  const drawerWidth = Math.min(360, Math.max(286, viewportWidth * 0.88));
  const [progress] = useState(() => new Animated.Value(isOpen ? 1 : 0));
  const [conversations, setConversations] = useState<CompletedConversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const animation = Animated.timing(progress, {
      duration: reducedMotion ? 0 : isOpen ? 220 : 170,
      toValue: isOpen ? 1 : 0,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [isOpen, progress, reducedMotion]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    Promise.resolve().then(() => {
      if (!active) return [];
      setLoading(true);
      setError(null);
      return conversationService.listCompletedConversations();
    }).then(
      (values) => {
        if (active) setConversations(values);
      },
      () => {
        if (active) setError('Chats could not be loaded.');
      },
    ).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [isOpen]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => gesture.dx < -8 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderMove: (_, gesture) => {
      progress.setValue(Math.max(0, Math.min(1, 1 + gesture.dx / drawerWidth)));
    },
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dx < -72 || gesture.vx < -0.55) {
        onClose();
        return;
      }
      Animated.spring(progress, {
        damping: 22,
        mass: 0.8,
        stiffness: 240,
        toValue: 1,
        useNativeDriver: true,
      }).start();
    },
    onPanResponderTerminate: () => {
      Animated.spring(progress, { toValue: 1, useNativeDriver: true }).start();
    },
  }), [drawerWidth, onClose, progress]);

  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [-drawerWidth, 0] });

  return (
    <View pointerEvents={isOpen ? 'auto' : 'none'} style={styles.layer} testID="chats-drawer-layer">
      <Animated.View style={[styles.backdrop, { opacity: progress }]}>
        <Pressable
          accessibilityLabel="Close Chats drawer"
          accessibilityRole="button"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
          testID="chats-drawer-backdrop"
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal={isOpen}
        style={[styles.drawer, { transform: [{ translateX }], width: drawerWidth }]}
        testID="chats-drawer"
        {...panResponder.panHandlers}
      >
        <View style={styles.header}>
          <Text style={styles.heading}>Chats</Text>
          <Pressable
            accessibilityLabel="Close Chats drawer"
            accessibilityRole="button"
            hitSlop={12}
            onPress={onClose}
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.centered}><ActivityIndicator color="#8F8F95" /></View>
        ) : error ? (
          <View style={styles.centered}>
            <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text>
          </View>
        ) : conversations.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyTitle}>No saved chats yet</Text>
            <Text style={styles.emptyBody}>New Chat saves completed conversations here.</Text>
          </View>
        ) : (
          <ChatsList compact conversations={conversations} onSelectChat={onSelectChat} />
        )}

        <Pressable
          accessibilityRole="button"
          onPress={onOpenFullChats}
          style={({ pressed }) => [styles.fullChatsButton, pressed && styles.pressed]}
        >
          <Text style={styles.fullChatsText}>Open full Chats</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0, zIndex: 20 },
  backdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.58)',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  drawer: {
    backgroundColor: '#0D0D0F',
    borderRightColor: '#262629',
    borderRightWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    left: 0,
    position: 'absolute',
    top: 0,
  },
  header: {
    alignItems: 'center',
    borderBottomColor: '#242427',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 58,
    paddingHorizontal: 18,
  },
  heading: { color: '#F7F7F8', fontSize: 19, fontWeight: '600' },
  closeButton: { alignItems: 'center', height: 40, justifyContent: 'center', width: 40 },
  closeText: { color: '#A1A1A6', fontSize: 28, fontWeight: '300', lineHeight: 30 },
  centered: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 28 },
  error: { color: '#E39A8E', fontSize: 13, textAlign: 'center' },
  emptyTitle: { color: '#F0F0F2', fontSize: 16, fontWeight: '500' },
  emptyBody: { color: '#85858A', fontSize: 13, lineHeight: 19, marginTop: 7, textAlign: 'center' },
  fullChatsButton: {
    borderTopColor: '#242427',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18,
    paddingVertical: 17,
  },
  fullChatsText: { color: '#A8A8AD', fontSize: 13, fontWeight: '500' },
  pressed: { opacity: 0.55 },
});
