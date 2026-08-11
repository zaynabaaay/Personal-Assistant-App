export type AuthenticatedUser = {
  id: string;
};

export type AccessTokenVerifier = (
  accessToken: string,
) => Promise<AuthenticatedUser>;
