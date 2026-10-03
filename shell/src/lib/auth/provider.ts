/** The shell's sign-in contract. Today it is backed by LegalAI's accounts; a Firebase provider can replace it without touching pages. */
export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

export type LoginResult = { kind: "ok"; user: SessionUser } | { kind: "mfa"; token: string };

export interface IdentityProvider {
  login(email: string, password: string): Promise<LoginResult>;
  loginMfa(token: string, code: string): Promise<SessionUser>;
  logout(): Promise<void>;
}
