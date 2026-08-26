import 'react-native-url-polyfill/auto';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import AuthLoadingScreen from '@/features/auth/auth-loading-screen';
import { AuthProvider, useAuth } from '@/features/auth/auth-provider';
import SignInScreen from '@/features/auth/sign-in-screen';

function AuthenticatedRouter() {
  const { status } = useAuth();

  if (status === 'loading') {
    return <AuthLoadingScreen />;
  }

  if (status !== 'authenticated') {
    return <SignInScreen />;
  }

  return (
    <Stack
      screenOptions={{
        animation: 'fade',
        contentStyle: { backgroundColor: '#050505' },
        headerShown: false,
      }}
    />
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <AuthenticatedRouter />
    </AuthProvider>
  );
}
