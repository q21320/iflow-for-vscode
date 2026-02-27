import * as fs from 'fs';
import * as vscode from 'vscode';
import { OAUTH_CREDS_PATH, OAUTH_SECRET_STORAGE_KEY } from '../authConstants';
import { AuthLogger, OAuthCredentials } from './types';

export class AuthCredentialsStore {
  private cachedCredentials: OAuthCredentials | null = null;
  private migrationChecked = false;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly logger: AuthLogger,
  ) {}

  async migrateLegacyCredentialsIfNeeded(): Promise<void> {
    if (this.migrationChecked) {
      return;
    }
    this.migrationChecked = true;

    const legacy = this.readLegacyCredentialsFromFile();
    if (!legacy) {
      return;
    }

    const existing = await this.readCredentialsFromSecretStorage();
    if (!existing) {
      await this.writeCredentials(legacy);
      this.logger.info('Migrated legacy OAuth credentials from file to SecretStorage');
    } else {
      this.logger.warn('Legacy OAuth credentials file exists, but SecretStorage already has credentials; skipping overwrite');
    }

    this.removeLegacyCredentialsFile();
  }

  async readCredentials(): Promise<OAuthCredentials | null> {
    if (this.cachedCredentials) {
      return this.cachedCredentials;
    }

    const creds = await this.readCredentialsFromSecretStorage();
    if (creds) {
      this.cachedCredentials = creds;
    }
    return creds;
  }

  async writeCredentials(creds: OAuthCredentials): Promise<void> {
    this.cachedCredentials = creds;
    await this.secrets.store(OAUTH_SECRET_STORAGE_KEY, JSON.stringify(creds));
  }

  async clearCredentials(): Promise<void> {
    this.cachedCredentials = null;
    await this.secrets.delete(OAUTH_SECRET_STORAGE_KEY);
  }

  removeLegacyCredentialsFile(): void {
    try {
      if (fs.existsSync(OAUTH_CREDS_PATH)) {
        fs.unlinkSync(OAUTH_CREDS_PATH);
      }
    } catch (err) {
      this.logger.error(`Failed to remove legacy credentials file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async readCredentialsFromSecretStorage(): Promise<OAuthCredentials | null> {
    try {
      const raw = await this.secrets.get(OAUTH_SECRET_STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (!this.isValidCredentials(parsed)) {
        this.logger.warn('SecretStorage credentials are malformed, clearing stored entry');
        await this.secrets.delete(OAUTH_SECRET_STORAGE_KEY);
        return null;
      }

      return parsed as OAuthCredentials;
    } catch (err) {
      this.logger.error(`Failed to read credentials from SecretStorage: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private readLegacyCredentialsFromFile(): OAuthCredentials | null {
    try {
      if (!fs.existsSync(OAUTH_CREDS_PATH)) {
        return null;
      }
      const content = fs.readFileSync(OAUTH_CREDS_PATH, 'utf-8');
      const parsed = JSON.parse(content);
      if (!this.isValidCredentials(parsed)) {
        this.logger.warn('Legacy oauth_creds.json is malformed and will be removed');
        return null;
      }
      return parsed as OAuthCredentials;
    } catch (err) {
      this.logger.error(`Failed to read legacy credentials file: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private isValidCredentials(value: unknown): value is OAuthCredentials {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record.access_token === 'string'
      && typeof record.refresh_token === 'string'
      && typeof record.expiry_date === 'number'
      && typeof record.token_type === 'string'
      && typeof record.scope === 'string'
      && typeof record.apiKey === 'string';
  }
}
