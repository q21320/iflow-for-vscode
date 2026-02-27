import { OAuthCredentials, TokenResponse } from './types';

interface EnsureValidTokenDeps {
  readCredentials(): Promise<OAuthCredentials | null>;
  refreshCredentials(refreshToken: string): Promise<TokenResponse>;
  writeCredentials(credentials: OAuthCredentials): Promise<void>;
  updateSettings(apiKey: string): void;
  logout(): Promise<void>;
  logInfo(message: string): void;
  logWarn(message: string): void;
  logError(message: string): void;
}

interface ClearCredentialsDeps {
  clearStoredCredentials(): Promise<void>;
  clearSettings(): void;
  removeLegacyCredentialsFile(): void;
}

export class TokenManager {
  isTokenExpiring(expiryDate: number, thresholdMs: number, now = Date.now()): boolean {
    return (expiryDate - now) <= thresholdMs;
  }

  async clearCredentials(deps: ClearCredentialsDeps): Promise<void> {
    await deps.clearStoredCredentials();
    deps.clearSettings();
    deps.removeLegacyCredentialsFile();
  }

  async ensureValidToken(
    deps: EnsureValidTokenDeps,
    thresholdMs: number,
  ): Promise<boolean> {
    const creds = await deps.readCredentials();
    if (!creds) {
      return false;
    }

    const timeUntilExpiry = creds.expiry_date - Date.now();
    if (!this.isTokenExpiring(creds.expiry_date, thresholdMs)) {
      return true;
    }

    if (timeUntilExpiry <= 0) {
      deps.logWarn('OAuth token expired, clearing credentials');
      await deps.logout();
      return false;
    }

    try {
      deps.logInfo('OAuth token expiring soon, refreshing...');
      const newTokens = await deps.refreshCredentials(creds.refresh_token);
      const updatedCreds: OAuthCredentials = {
        ...creds,
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        expiry_date: Date.now() + newTokens.expires_in * 1000,
        token_type: newTokens.token_type,
        scope: newTokens.scope,
      };
      await deps.writeCredentials(updatedCreds);
      deps.updateSettings(updatedCreds.apiKey);
      deps.logInfo('OAuth token refreshed successfully');
      return true;
    } catch (err) {
      deps.logError(`Token refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
