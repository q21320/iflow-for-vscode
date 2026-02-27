import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as url from 'url';
import * as vscode from 'vscode';
import {
  OAUTH_CLIENT_ID,
  OAUTH_AUTH_URL,
  OAUTH_TOKEN_URL,
  OAUTH_USERINFO_URL,
  OAUTH_CALLBACK_PATH,
  TOKEN_REFRESH_THRESHOLD_MS,
  OAUTH_CALLBACK_TIMEOUT_MS,
  OAUTH_REQUEST_TIMEOUT_MS,
} from './authConstants';
import { AuthCredentialsStore } from './auth/credentialsStore';
import { AuthSettingsStore } from './auth/settingsStore';
import { AuthLogger, OAuthCredentials, TokenResponse, UserInfoResponse } from './auth/types';

export type { OAuthCredentials } from './auth/types';

interface AuthServiceDependencies {
  credentialsStore?: AuthCredentialsStore;
  settingsStore?: AuthSettingsStore;
}

export class AuthService {
  private callbackServer: http.Server | null = null;
  private outputChannel: vscode.OutputChannel | null = null;
  private readonly credentialsStore: AuthCredentialsStore;
  private readonly settingsStore: AuthSettingsStore;
  private readonly logger: AuthLogger;

  constructor(
    secrets: vscode.SecretStorage,
    deps: AuthServiceDependencies = {},
  ) {
    this.logger = {
      info: (message: string) => this.logInfo(message),
      warn: (message: string) => this.logWarn(message),
      error: (message: string) => this.logError(message),
    };
    this.credentialsStore = deps.credentialsStore ?? new AuthCredentialsStore(secrets, this.logger);
    this.settingsStore = deps.settingsStore ?? new AuthSettingsStore(this.logger);
  }

  // ── Public API ────────────────────────────────────────────────

  /**
   * Start full OAuth login flow with PKCE:
   * 1. Start local callback server on a dynamic port
   * 2. Open browser to iFlow OAuth page with code_challenge
   * 3. Wait for callback with authorization code
   * 4. Exchange code for tokens using code_verifier (no client_secret)
   * 5. Fetch user info (including apiKey)
   * 6. Save credentials to SecretStorage
   */
  async startLogin(): Promise<void> {
    await this.migrateLegacyCredentialsIfNeeded();

    // Prevent concurrent login flows
    if (this.callbackServer) {
      throw new Error('A login flow is already in progress');
    }

    const state = crypto.randomBytes(32).toString('hex');
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.generateCodeChallenge(codeVerifier);

    let callbackResult: { code: string; port: number };
    try {
      callbackResult = await this.startCallbackServer(state, codeChallenge);
    } finally {
      this.stopCallbackServer();
    }

    const { code, port } = callbackResult;
    const redirectUri = `http://localhost:${port}${OAUTH_CALLBACK_PATH}`;

    // Exchange code for tokens
    const tokens = await this.exchangeCodeForTokens(code, redirectUri, codeVerifier);

    // Fetch user info
    const userInfo = await this.fetchUserInfo(tokens.access_token);

    const credentials: OAuthCredentials = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: Date.now() + tokens.expires_in * 1000,
      token_type: tokens.token_type,
      scope: tokens.scope,
      apiKey: userInfo.apiKey,
      userId: userInfo.userId,
      userName: userInfo.userName,
      avatar: userInfo.avatar,
      email: userInfo.email,
      phone: userInfo.phone,
    };

    await this.writeCredentials(credentials);
    this.updateSettings(credentials.apiKey);
    this.logInfo(`Login successful for user: ${credentials.userName}`);
  }

  /** Clear stored OAuth credentials. */
  async logout(): Promise<void> {
    try {
      await this.clearStoredCredentials();
      this.clearSettings();
      this.removeLegacyCredentialsFile();
      this.logInfo('Logged out successfully');
    } catch (err) {
      this.logError(`Logout error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Ensure the access token is valid; refresh if expiring within 24 hours.
   * Returns true if auth is valid, false if not logged in or refresh failed.
   */
  async ensureValidToken(): Promise<boolean> {
    await this.migrateLegacyCredentialsIfNeeded();

    const creds = await this.readCredentials();
    if (!creds) {
      return false;
    }

    const timeUntilExpiry = creds.expiry_date - Date.now();
    if (timeUntilExpiry > TOKEN_REFRESH_THRESHOLD_MS) {
      return true;
    }

    if (timeUntilExpiry <= 0) {
      this.logWarn('OAuth token expired, clearing credentials');
      await this.logout();
      return false;
    }

    try {
      this.logInfo('OAuth token expiring soon, refreshing...');
      const newTokens = await this.refreshAccessToken(creds.refresh_token);
      const updatedCreds: OAuthCredentials = {
        ...creds,
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        expiry_date: Date.now() + newTokens.expires_in * 1000,
        token_type: newTokens.token_type,
        scope: newTokens.scope,
      };
      await this.writeCredentials(updatedCreds);
      this.updateSettings(updatedCreds.apiKey);
      this.logInfo('OAuth token refreshed successfully');
      return true;
    } catch (err) {
      this.logError(`Token refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Check if OAuth credentials exist. */
  async isLoggedIn(): Promise<boolean> {
    await this.migrateLegacyCredentialsIfNeeded();
    return (await this.readCredentials()) !== null;
  }

  dispose(): void {
    this.stopCallbackServer();
  }

  // ── Private: Logging ──────────────────────────────────────────

  private logInfo(message: string): void {
    this.appendLog('INFO', message);
  }

  private logWarn(message: string): void {
    this.appendLog('WARN', message);
  }

  private logError(message: string): void {
    this.appendLog('ERROR', message);
  }

  private appendLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel('IFlow Auth');
    }
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] [${level}] ${message}`);
  }

  // ── Private: Secret storage + migration ───────────────────────

  private async migrateLegacyCredentialsIfNeeded(): Promise<void> {
    await this.credentialsStore.migrateLegacyCredentialsIfNeeded();
  }

  private async readCredentials(): Promise<OAuthCredentials | null> {
    return this.credentialsStore.readCredentials();
  }

  private async writeCredentials(creds: OAuthCredentials): Promise<void> {
    await this.credentialsStore.writeCredentials(creds);
  }

  private async clearStoredCredentials(): Promise<void> {
    await this.credentialsStore.clearCredentials();
  }

  private removeLegacyCredentialsFile(): void {
    this.credentialsStore.removeLegacyCredentialsFile();
  }

  // ── Private: settings.json I/O ────────────────────────────────

  private updateSettings(apiKey: string): void {
    this.settingsStore.updateSettings(apiKey);
  }

  private clearSettings(): void {
    this.settingsStore.clearSettings();
  }

  // ── Private: PKCE + callback server ───────────────────────────

  private getOAuthClientId(): string {
    return vscode.workspace.getConfiguration('iflow').get<string>('oauthClientId', OAUTH_CLIENT_ID);
  }

  private toBase64Url(input: Buffer): string {
    return input
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  private generateCodeVerifier(): string {
    return this.toBase64Url(crypto.randomBytes(32));
  }

  private generateCodeChallenge(verifier: string): string {
    return this.toBase64Url(crypto.createHash('sha256').update(verifier).digest());
  }

  /**
   * Start a local HTTP server on a dynamic port and wait for OAuth callback.
   */
  private startCallbackServer(expectedState: string, codeChallenge: string): Promise<{ code: string; port: number }> {
    return new Promise<{ code: string; port: number }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const parsed = url.parse(req.url || '', true);

        if (parsed.pathname !== OAUTH_CALLBACK_PATH) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }

        const code = parsed.query.code as string | undefined;
        const state = parsed.query.state as string | undefined;

        if (!code || !state) {
          clearTimeout(timeout);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><h2>Authentication failed</h2><p>Missing code or state parameter.</p></body></html>');
          server.close();
          reject(new Error('Missing code or state in OAuth callback'));
          return;
        }

        if (state !== expectedState) {
          clearTimeout(timeout);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><h2>Authentication failed</h2><p>State mismatch (possible CSRF attack).</p></body></html>');
          server.close();
          reject(new Error('OAuth state mismatch'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
          <div style="text-align:center;">
            <h2>Authentication Successful</h2>
            <p>You can close this tab and return to VS Code.</p>
          </div>
        </body></html>`);

        const port = (server.address() as { port: number }).port;
        clearTimeout(timeout);
        server.close();
        resolve({ code, port });
      });

      this.callbackServer = server;

      const timeout = setTimeout(() => {
        this.stopCallbackServer();
        reject(new Error('OAuth callback timed out (2 minutes). Please try again.'));
      }, OAUTH_CALLBACK_TIMEOUT_MS);

      server.on('close', () => clearTimeout(timeout));

      server.listen(0, 'localhost', () => {
        const addr = server.address() as { port: number };
        const port = addr.port;
        this.logInfo(`OAuth callback server listening on port ${port}`);

        const redirectUri = `http://localhost:${port}${OAUTH_CALLBACK_PATH}`;
        const params = new url.URLSearchParams({
          loginMethod: 'phone',
          type: 'phone',
          response_type: 'code',
          redirect: redirectUri,
          state: expectedState,
          client_id: this.getOAuthClientId(),
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        });
        const authUrl = `${OAUTH_AUTH_URL}?${params.toString()}`;

        this.logInfo(`Opening browser: ${authUrl}`);
        vscode.env.openExternal(vscode.Uri.parse(authUrl)).then((ok) => {
          if (!ok) {
            this.logWarn('Failed to open OAuth URL in browser');
          }
        }, (err: unknown) => {
          this.logError(`Failed to open OAuth URL: ${err instanceof Error ? err.message : String(err)}`);
        });
      });

      server.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
      });
    });
  }

  private stopCallbackServer(): void {
    if (this.callbackServer) {
      try {
        this.callbackServer.close();
      } catch (err) {
        this.logWarn(`Error closing callback server: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.callbackServer = null;
    }
  }

  // ── Private: OAuth API calls ──────────────────────────────────

  private async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<TokenResponse> {
    const response = await this.httpsPost(OAUTH_TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.getOAuthClientId(),
      code_verifier: codeVerifier,
    });

    if (!response.access_token) {
      throw new Error(`Token exchange failed: ${JSON.stringify(response)}`);
    }

    return {
      access_token: response.access_token as string,
      refresh_token: response.refresh_token as string,
      expires_in: this.parseExpiresInSeconds(response.expires_in),
      token_type: (response.token_type as string) || 'bearer',
      scope: (response.scope as string) || 'read',
    };
  }

  private async fetchUserInfo(accessToken: string): Promise<UserInfoResponse> {
    const response = await this.httpsGet(OAUTH_USERINFO_URL, {
      Authorization: `Bearer ${accessToken}`,
    });

    const data = (response.data ?? response) as Record<string, unknown>;
    if (!data.apiKey) {
      throw new Error(`Failed to fetch user info: ${JSON.stringify(response)}`);
    }

    return {
      apiKey: data.apiKey as string,
      userId: (data.userId as string) || '',
      userName: (data.userName as string) || '',
      avatar: (data.avatar as string) || '',
      email: (data.email as string) || '',
      phone: (data.phone as string) || '',
    };
  }

  private async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const response = await this.httpsPost(OAUTH_TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.getOAuthClientId(),
    });

    if (!response.access_token) {
      throw new Error(`Token refresh failed: ${JSON.stringify(response)}`);
    }

    return {
      access_token: response.access_token as string,
      refresh_token: (response.refresh_token as string) || refreshToken,
      expires_in: this.parseExpiresInSeconds(response.expires_in),
      token_type: (response.token_type as string) || 'bearer',
      scope: (response.scope as string) || 'read',
    };
  }

  // ── Private: HTTPS helpers ────────────────────────────────────

  private httpsPost(requestUrl: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const body = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const parsed = new url.URL(requestUrl);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    return this.sendHttpsRequest(options, body);
  }

  private httpsGet(
    requestUrl: string,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const parsed = new url.URL(requestUrl);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
    };
    return this.sendHttpsRequest(options);
  }

  private sendHttpsRequest(
    options: https.RequestOptions,
    body?: string,
  ): Promise<Record<string, unknown>> {
    const timeoutMs = this.getOAuthRequestTimeoutMs();

    return new Promise((resolve, reject) => {
      let settled = false;
      const method = options.method ?? 'GET';
      const pathForLog = options.path ?? '/';

      const req = https.request(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          if (settled) {
            return;
          }
          settled = true;
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 400) {
            reject(new Error(`HTTPS ${method} ${pathForLog} failed with status ${statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (err) {
            reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}; parser error: ${err instanceof Error ? err.message : String(err)}`));
          }
        });
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`HTTPS ${method} ${pathForLog} timed out after ${timeoutMs}ms`));
      });
      req.on('error', (err) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(`HTTPS ${method} ${pathForLog} failed: ${err.message}`));
      });
      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }

  private getOAuthRequestTimeoutMs(): number {
    const configured = vscode.workspace
      .getConfiguration('iflow')
      .get<number>('oauthRequestTimeoutMs', OAUTH_REQUEST_TIMEOUT_MS);
    if (!Number.isFinite(configured) || configured <= 0) {
      return OAUTH_REQUEST_TIMEOUT_MS;
    }
    return Math.round(configured);
  }

  private parseExpiresInSeconds(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.round(parsed);
      }
    }
    throw new Error(`Invalid OAuth expires_in value: ${String(value)}`);
  }
}
