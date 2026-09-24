import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/features/auth/auth-provider';

export default function AccountScreen() {
  const { signOut, user } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    setError(null);

    try {
      await signOut();
    } catch {
      setError('Unable to sign out. Please try again.');
      setIsSigningOut(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <Pressable accessibilityRole="button" onPress={() => router.back()}>
          <Text style={styles.back}>Back</Text>
        </Pressable>
        <Text style={styles.eyebrow}>Account</Text>
        <Text style={styles.title}>Private owner</Text>
        <Text style={styles.detail}>{user?.email ?? user?.id}</Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          accessibilityRole="button"
          disabled={isSigningOut}
          onPress={handleSignOut}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
          <Text style={styles.buttonText}>{isSigningOut ? 'Signing out…' : 'Sign out'}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  back: { color: '#77746D', fontSize: 15, marginBottom: 42 },
  button: {
    alignItems: 'center',
    borderColor: '#D8D5CD',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    height: 46,
    justifyContent: 'center',
    marginTop: 34,
  },
  buttonPressed: { opacity: 0.6 },
  buttonText: { color: '#4A4945', fontSize: 16 },
  content: { maxWidth: 420, padding: 28, width: '100%' },
  detail: { color: '#77746D', fontSize: 15, marginTop: 10 },
  error: { color: '#8B5E52', fontSize: 14, marginTop: 20 },
  eyebrow: { color: '#8B8983', fontSize: 12, textTransform: 'uppercase' },
  safeArea: { backgroundColor: '#F5F4F0', flex: 1 },
  title: { color: '#343330', fontSize: 28, marginTop: 8 },
});
