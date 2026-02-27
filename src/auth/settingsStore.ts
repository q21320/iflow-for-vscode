import * as fs from 'fs';
import { IFLOW_DIR, SETTINGS_PATH } from '../authConstants';
import { AuthLogger } from './types';

export class AuthSettingsStore {
  constructor(private readonly logger: AuthLogger) {}

  updateSettings(apiKey: string): void {
    try {
      let settings: Record<string, unknown> = {};
      if (fs.existsSync(SETTINGS_PATH)) {
        try {
          settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
        } catch (err) {
          this.logger.warn(`Failed to parse settings.json, recreating file: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const updated = {
        ...settings,
        selectedAuthType: 'oauth-iflow',
        apiKey,
      };
      if (!fs.existsSync(IFLOW_DIR)) {
        fs.mkdirSync(IFLOW_DIR, { recursive: true });
      }
      const content = JSON.stringify(updated, null, 2);
      if (process.platform === 'win32') {
        fs.writeFileSync(SETTINGS_PATH, content, 'utf-8');
      } else {
        fs.writeFileSync(SETTINGS_PATH, content, { encoding: 'utf-8', mode: 0o600 });
      }
    } catch (err) {
      this.logger.error(`Failed to update settings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  clearSettings(): void {
    try {
      if (!fs.existsSync(SETTINGS_PATH)) {
        return;
      }
      const settings: Record<string, unknown> = JSON.parse(
        fs.readFileSync(SETTINGS_PATH, 'utf-8')
      );
      const { selectedAuthType: _selectedAuthType, apiKey: _apiKey, ...rest } = settings;
      const content = JSON.stringify(rest, null, 2);
      if (process.platform === 'win32') {
        fs.writeFileSync(SETTINGS_PATH, content, 'utf-8');
      } else {
        fs.writeFileSync(SETTINGS_PATH, content, { encoding: 'utf-8', mode: 0o600 });
      }
    } catch (err) {
      this.logger.error(`Failed to clear settings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
