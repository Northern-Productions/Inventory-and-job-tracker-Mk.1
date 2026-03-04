export interface AuthUser {
  email: string;
  hasProfileName: boolean;
  name: string;
  picture: string;
  sub: string;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
  issuedAt: number;
  expiresAt: number;
}
