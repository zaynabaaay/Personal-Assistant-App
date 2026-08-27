import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from './auth-provider';

const KEYBOARD_BEHAVIOR = Platform.OS === 'ios' ? 'padding' : undefined;

export default function SignInScreen() {
  const { errorMessage, signIn, status } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const canSubmit =
    status !== 'configuration_error' &&
    email.trim().length > 0 &&
    password.length > 0 &&
    !isSubmitting;

  const submit = async () => {
    if (!canSubmit) {
      return;
    }

    setIsSubmitting(true);
    setSignInError(null);

    try {
      await signIn(email, password);
    } catch {
      setSignInError('Unable to sign in. Check your email and password.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView behavior={KEYBOARD_BEHAVIOR} style={styles.keyboardView}>
        <View style={styles.content}>
          <Text style={styles.eyebrow}>Personal Assistant</Text>
          <Text style={styles.title}>Sign in</Text>
          <Text style={styles.description}>
            Use the private owner account configured for this assistant.
          </Text>

          <View style={styles.form}>
            <TextInput
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              keyboardType="email-address"
              onChangeText={setEmail}
              placeholder="Email"
              placeholderTextColor="#8B8983"
              style={styles.input}
              textContentType="username"
              value={email}
            />
            <TextInput
              autoCapitalize="none"
              autoComplete="current-password"
              onChangeText={setPassword}
              onSubmitEditing={submit}
              placeholder="Password"
              placeholderTextColor="#8B8983"
              returnKeyType="go"
              secureTextEntry
              style={styles.input}
              textContentType="password"
              value={password}
            />

            {signInError || errorMessage ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {signInError ?? errorMessage}
              </Text>
            ) : null}

            <Pressable
              accessibilityRole="button"
              disabled={!canSubmit}
              onPress={submit}
              style={({ pressed }) => [
                styles.button,
                !canSubmit && styles.buttonDisabled,
                pressed && canSubmit && styles.buttonPressed,
              ]}
            >
              {isSubmitting ? (
                <ActivityIndicator color="#F5F4F0" />
              ) : (
                <Text style={styles.buttonText}>Sign in</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: '#3E3D39',
    borderRadius: 22,
    height: 46,
    justifyContent: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.35 },
  buttonPressed: { opacity: 0.78 },
  buttonText: { color: '#F5F4F0', fontSize: 16 },
  content: { maxWidth: 420, paddingHorizontal: 28, width: '100%' },
  description: { color: '#77746D', fontSize: 15, lineHeight: 22, marginTop: 10 },
  error: { color: '#8B5E52', fontSize: 14, lineHeight: 20 },
  eyebrow: { color: '#8B8983', fontSize: 12, textTransform: 'uppercase' },
  form: { gap: 12, marginTop: 32 },
  input: {
    backgroundColor: '#FBFAF7',
    borderColor: '#E2E0D9',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    color: '#343330',
    fontSize: 16,
    height: 46,
    paddingHorizontal: 18,
  },
  keyboardView: { flex: 1, justifyContent: 'center' },
  safeArea: { backgroundColor: '#F5F4F0', flex: 1 },
  title: { color: '#343330', fontSize: 32, marginTop: 8 },
});
