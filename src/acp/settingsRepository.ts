import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ModelType } from '../protocol';

export class SettingsRepository {
  constructor(private readonly log: (message: string) => void) {}

  getSelectedAuthType(): string | null {
    try {
      const { settings } = this.readSettings();
      const selectedAuthType = settings.selectedAuthType;
      if (typeof selectedAuthType !== 'string') {
        return null;
      }
      const normalized = selectedAuthType.trim();
      return normalized.length > 0 ? normalized : null;
    } catch (err: unknown) {
      this.log(`Failed to read selected auth type: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  updateModel(model: ModelType): void {
    try {
      const { settings, path: settingsPath } = this.readSettings();
      if (settings.modelName !== model) {
        this.writeSettings({ ...settings, modelName: model }, settingsPath);
      }
    } catch (err: unknown) {
      this.log(`Failed to update model: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  updateBaseUrl(baseUrl: string | null): void {
    try {
      if (!baseUrl) {
        return;
      }
      const { settings, path: settingsPath } = this.readSettings();
      if (settings.baseUrl !== baseUrl) {
        this.writeSettings({ ...settings, baseUrl }, settingsPath);
      }
    } catch (err: unknown) {
      this.log(`Failed to update API config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private readSettings(): { settings: Record<string, unknown>; path: string } {
    const settingsPath = this.getIFlowSettingsPath();
    const dir = path.dirname(settingsPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(settingsPath)) {
      return { settings: {}, path: settingsPath };
    }

    try {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      return { settings: JSON.parse(content), path: settingsPath };
    } catch (err: unknown) {
      this.log(`Failed to parse settings at ${settingsPath}, returning empty: ${err instanceof Error ? err.message : String(err)}`);
      return { settings: {}, path: settingsPath };
    }
  }

  private writeSettings(settings: Record<string, unknown>, settingsPath: string): boolean {
    try {
      const dir = path.dirname(settingsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      return true;
    } catch (err: unknown) {
      this.log(`Failed to write settings: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private getIFlowSettingsPath(): string {
    return path.join(os.homedir(), '.iflow', 'settings.json');
  }
}
