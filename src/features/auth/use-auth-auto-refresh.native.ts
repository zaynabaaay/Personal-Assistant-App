import { useEffect } from 'react';
import { AppState } from 'react-native';

import type { AuthService } from '@/services/auth';

export function useAuthAutoRefresh(authService: AuthService) {
  useEffect(() => {
    const updateRefreshState = (state: string) => {
      if (state === 'active') {
        authService.startAutoRefresh();
      } else {
        authService.stopAutoRefresh();
      }
    };
    const subscription = AppState.addEventListener('change', updateRefreshState);

    updateRefreshState(AppState.currentState);

    return () => {
      subscription.remove();
      authService.stopAutoRefresh();
    };
  }, [authService]);
}
