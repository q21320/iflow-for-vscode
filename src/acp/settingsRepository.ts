import * as os from "os";
import * as path from "path";
import { ModelType } from "../protocol";
import { normalizeErrorMessage } from "../errorUtils";
import { JsonFileStore } from "../shared/jsonFileStore";

export class SettingsRepository {
  private readonly store: JsonFileStore;

  constructor(private readonly log: (message: string) => void) {
    this.store = new JsonFileStore(
      path.join(os.homedir(), ".iflow", "settings.json"),
      log,
    );
  }

  getSelectedAuthType(): string | null {
    try {
      const settings = this.store.read();
      const selectedAuthType = settings.selectedAuthType;
      if (typeof selectedAuthType !== "string") {
        return null;
      }
      const normalized = selectedAuthType.trim();
      return normalized.length > 0 ? normalized : null;
    } catch (err: unknown) {
      this.log(
        `Failed to read selected auth type: ${normalizeErrorMessage(err)}`,
      );
      return null;
    }
  }

  updateModel(model: ModelType): void {
    try {
      const settings = this.store.read();
      if (settings.modelName !== model) {
        this.store.write({ ...settings, modelName: model });
      }
    } catch (err: unknown) {
      this.log(`Failed to update model: ${normalizeErrorMessage(err)}`);
    }
  }

  updateBaseUrl(baseUrl: string | null): void {
    try {
      if (!baseUrl) {
        return;
      }
      const settings = this.store.read();
      if (settings.baseUrl !== baseUrl) {
        this.store.write({ ...settings, baseUrl });
      }
    } catch (err: unknown) {
      this.log(`Failed to update API config: ${normalizeErrorMessage(err)}`);
    }
  }
}
