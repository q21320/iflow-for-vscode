import * as crypto from 'crypto';
import * as url from 'url';
import { OAUTH_AUTH_URL, OAUTH_TOKEN_URL } from '../authConstants';
import { TokenResponse } from './types';

interface PkceFlowDeps {
  getOAuthClientId(): string;
  parseExpiresInSeconds(value: unknown): number;
  httpsPost(requestUrl: string, params: Record<string, string>): Promise<Record<string, unknown>>;
}

export class PkceFlow {
  constructor(private readonly deps: PkceFlowDeps) {}

  generateCodeVerifier(): string {
    return this.toBase64Url(crypto.randomBytes(32));
  }

  generateCodeChallenge(verifier: string): string {
    return this.toBase64Url(crypto.createHash('sha256').update(verifier).digest());
  }

  buildAuthorizeUrl(redirectUri: string, state: string, codeChallenge: string): string {
    const params = new url.URLSearchParams({
      loginMethod: 'phone',
      type: 'phone',
      response_type: 'code',
      redirect: redirectUri,
      state,
      client_id: this.deps.getOAuthClientId(),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return `${OAUTH_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<TokenResponse> {
    const response = await this.deps.httpsPost(OAUTH_TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.deps.getOAuthClientId(),
      code_verifier: codeVerifier,
    });

    if (!response.access_token) {
      throw new Error(`Token exchange failed: ${JSON.stringify(response)}`);
    }

    return {
      access_token: response.access_token as string,
      refresh_token: response.refresh_token as string,
      expires_in: this.deps.parseExpiresInSeconds(response.expires_in),
      token_type: (response.token_type as string) || 'bearer',
      scope: (response.scope as string) || 'read',
    };
  }

  async refreshCredentials(refreshToken: string): Promise<TokenResponse> {
    const response = await this.deps.httpsPost(OAUTH_TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.deps.getOAuthClientId(),
    });

    if (!response.access_token) {
      throw new Error(`Token refresh failed: ${JSON.stringify(response)}`);
    }

    return {
      access_token: response.access_token as string,
      refresh_token: (response.refresh_token as string) || refreshToken,
      expires_in: this.deps.parseExpiresInSeconds(response.expires_in),
      token_type: (response.token_type as string) || 'bearer',
      scope: (response.scope as string) || 'read',
    };
  }

  private toBase64Url(input: Buffer): string {
    return input
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }
}
