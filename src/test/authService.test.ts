import * as assert from 'assert';
import { AuthService } from '../authService';

class FakeSecrets {
  private data = new Map<string, string>();

  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.data.get(key));
  }

  store(key: string, value: string): Thenable<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Thenable<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
}

suite('AuthService', () => {
  test('startLogin completes PKCE flow and persists credentials', async () => {
    const service = new AuthService(new FakeSecrets() as unknown as import('vscode').SecretStorage);
    let stored: Record<string, unknown> | null = null;

    (service as any).migrateLegacyCredentialsIfNeeded = async () => {};
    (service as any).startCallbackServer = async () => ({ code: 'auth-code', port: 3456 });
    (service as any).exchangeCodeForTokens = async (_code: string, _redirect: string, verifier: string) => {
      assert.ok(typeof verifier === 'string' && verifier.length > 0);
      return {
        access_token: 'token-a',
        refresh_token: 'token-r',
        expires_in: 3600,
        token_type: 'bearer',
        scope: 'read',
      };
    };
    (service as any).fetchUserInfo = async () => ({
      apiKey: 'api-key',
      userId: 'u1',
      userName: 'tester',
      avatar: '',
      email: 'user@example.com',
      phone: '',
    });
    (service as any).writeCredentials = async (creds: Record<string, unknown>) => {
      stored = creds;
    };
    (service as any).updateSettings = (_apiKey: string) => {};

    await service.startLogin();

    assert.ok(stored);
    const persisted = stored as Record<string, unknown>;
    assert.strictEqual(persisted.access_token, 'token-a');
    assert.strictEqual(persisted.apiKey, 'api-key');
  });

  test('ensureValidToken returns false when credentials are missing', async () => {
    const service = new AuthService(new FakeSecrets() as unknown as import('vscode').SecretStorage);
    (service as any).migrateLegacyCredentialsIfNeeded = async () => {};
    (service as any).readCredentials = async () => null;

    const ok = await service.ensureValidToken();
    assert.strictEqual(ok, false);
  });

  test('ensureValidToken refreshes credentials near expiry', async () => {
    const service = new AuthService(new FakeSecrets() as unknown as import('vscode').SecretStorage);
    const now = Date.now();
    let writeCalled = false;

    (service as any).migrateLegacyCredentialsIfNeeded = async () => {};
    (service as any).readCredentials = async () => ({
      access_token: 'old-a',
      refresh_token: 'old-r',
      expiry_date: now + 1000,
      token_type: 'bearer',
      scope: 'read',
      apiKey: 'api-key',
      userId: 'u1',
      userName: 'tester',
      avatar: '',
      email: '',
      phone: '',
    });
    (service as any).refreshAccessToken = async (_refreshToken: string) => ({
      access_token: 'new-a',
      refresh_token: 'new-r',
      expires_in: 3600,
      token_type: 'bearer',
      scope: 'read',
    });
    (service as any).writeCredentials = async (creds: Record<string, unknown>) => {
      writeCalled = true;
      assert.strictEqual(creds.access_token, 'new-a');
    };
    (service as any).updateSettings = (_apiKey: string) => {};

    const ok = await service.ensureValidToken();
    assert.strictEqual(ok, true);
    assert.strictEqual(writeCalled, true);
  });

  test('ensureValidToken clears expired credentials', async () => {
    const service = new AuthService(new FakeSecrets() as unknown as import('vscode').SecretStorage);
    let logoutCalled = false;

    (service as any).migrateLegacyCredentialsIfNeeded = async () => {};
    (service as any).readCredentials = async () => ({
      access_token: 'old-a',
      refresh_token: 'old-r',
      expiry_date: Date.now() - 1000,
      token_type: 'bearer',
      scope: 'read',
      apiKey: 'api-key',
      userId: 'u1',
      userName: 'tester',
      avatar: '',
      email: '',
      phone: '',
    });
    (service as any).logout = async () => {
      logoutCalled = true;
    };

    const ok = await service.ensureValidToken();
    assert.strictEqual(ok, false);
    assert.strictEqual(logoutCalled, true);
  });

  test('isLoggedIn reflects credential presence', async () => {
    const service = new AuthService(new FakeSecrets() as unknown as import('vscode').SecretStorage);
    (service as any).migrateLegacyCredentialsIfNeeded = async () => {};
    (service as any).readCredentials = async () => ({ access_token: 'x' });

    const loggedIn = await service.isLoggedIn();
    assert.strictEqual(loggedIn, true);
  });
});
