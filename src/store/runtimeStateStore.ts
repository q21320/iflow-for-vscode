import { SavedConversationState } from './storeTypes';
import {
  INITIAL_RUNTIME_STATE_SNAPSHOT,
  RuntimeStateSnapshot,
  RuntimeStateSource,
} from './runtimeStateSource';

export class RuntimeStateStore {
  private readonly runtimeStateSource: RuntimeStateSource;

  constructor(saved: SavedConversationState | undefined) {
    const initialRuntimeState: RuntimeStateSnapshot = {
      ...INITIAL_RUNTIME_STATE_SNAPSHOT,
      cliAvailable: saved?.cliAvailable ?? INITIAL_RUNTIME_STATE_SNAPSHOT.cliAvailable,
      cliVersion: saved?.cliVersion ?? INITIAL_RUNTIME_STATE_SNAPSHOT.cliVersion,
      cliDiagnostics: saved?.cliDiagnostics ?? INITIAL_RUNTIME_STATE_SNAPSHOT.cliDiagnostics,
    };

    this.runtimeStateSource = new RuntimeStateSource(initialRuntimeState);
  }

  getSnapshot(): RuntimeStateSnapshot {
    return this.runtimeStateSource.getSnapshot();
  }

  setCliStatus(available: boolean, version: string | null, diagnostics?: string): void {
    this.runtimeStateSource.setCliStatus(available, version, diagnostics);
  }

  setWorkspaceFolders(folders: Array<{ uri: string; name: string }>): void {
    this.runtimeStateSource.setWorkspaceFolders(folders);
  }

  setStreaming(streaming: boolean): void {
    this.runtimeStateSource.setStreaming(streaming);
  }
}
