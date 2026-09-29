import { loadConfig } from './api';

export interface AuthTokens {
  idToken: string;
  accessToken: string;
  expiresAt: number;
}

const TOKEN_KEY = 'auth_tokens';

export function getStoredTokens(): AuthTokens | null {
  const stored = sessionStorage.getItem(TOKEN_KEY);
  if (!stored) return null;
  const tokens: AuthTokens = JSON.parse(stored);
  if (Date.now() > tokens.expiresAt) {
    sessionStorage.removeItem(TOKEN_KEY);
    return null;
  }
  return tokens;
}

function storeTokens(tokens: AuthTokens): void {
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

export function parseTokensFromHash(): AuthTokens | null {
  const hash = window.location.hash.substring(1);
  if (!hash) return null;

  const params = new URLSearchParams(hash);
  const idToken = params.get('id_token');
  const accessToken = params.get('access_token');
  const expiresIn = params.get('expires_in');

  if (!idToken || !accessToken) return null;

  const tokens: AuthTokens = {
    idToken,
    accessToken,
    expiresAt: Date.now() + (parseInt(expiresIn || '3600') * 1000),
  };

  storeTokens(tokens);
  // Clean the URL
  window.history.replaceState(null, '', window.location.pathname);
  return tokens;
}

export async function redirectToLogin(): Promise<void> {
  const config = await loadConfig();
  const loginUrl = `https://${config.cognitoDomain}/login?` +
    `client_id=${config.cognitoClientId}` +
    `&response_type=token` +
    `&scope=openid+email+profile` +
    `&redirect_uri=${encodeURIComponent(config.cognitoRedirectUri)}`;
  window.location.href = loginUrl;
}

export async function logout(): Promise<void> {
  sessionStorage.removeItem(TOKEN_KEY);
  const config = await loadConfig();
  const logoutUrl = `https://${config.cognitoDomain}/logout?` +
    `client_id=${config.cognitoClientId}` +
    `&logout_uri=${encodeURIComponent(config.cognitoRedirectUri)}`;
  window.location.href = logoutUrl;
}

export function isAuthenticated(): boolean {
  return getStoredTokens() !== null;
}
