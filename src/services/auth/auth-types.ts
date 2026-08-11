export type AuthenticatedUser = {
  email?: string;
  id: string;
};

export type AuthStatus =
  | 'authenticated'
  | 'configuration_error'
  | 'loading'
  | 'unauthenticated';

export type AuthState = {
  errorMessage?: string;
  status: AuthStatus;
  user: AuthenticatedUser | null;
};

export type AuthSession = {
  accessToken: string;
  user: AuthenticatedUser;
};
