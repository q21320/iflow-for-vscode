import { SavedConversationState } from './storeTypes';
import {
  INITIAL_RUNTIME_STATE_SNAPSHOT,
  RuntimeStateSnapshot,
  RuntimeStateSource,
} from './runtimeStateSource';

function cloneRuntimeSnapshot(snapshot: RuntimeStateSnapshot): RuntimeStateSnapshot {
  return {
    ...snapshot,
    workspaceFolders: snapshot.workspaceFolders.map((folder) => ({ ...folder })),
  };
}

export class RuntimeStateStore {
  private readonly runtimeStateSource: RuntimeStateSource;
  private legacyRuntimeState: RuntimeStateSnapshot;

  constructor(saved: SavedConversationState | undefined, private readonly useRuntimeSnapshot: boolean) {
    const initialRuntimeState: RuntimeStateSnapshot = {
      ...INITIAL_RUNTIME_STATE_SNAPSHOT,
      cliAvailable: saved?.cliAvailable ?? INITIAL_RUNTIME_STATE_SNAPSHOT.cliAvailable,
      cliVersion: saved?.cliVersion ?? INITIAL_RUNTIME_STATE_SNAPSHOT.cliVersion,
      cliDiagnostics: saved?.cliDiagnostics ?? INITIAL_RUNTIME_STATE_SNAPSHOT.cliDiagnostics,
    };

    this.runtimeStateSource = new RuntimeStateSource(initialRuntimeState);
    this.legacyRuntimeState = cloneRuntimeSnapshot(initialRuntimeState);
  }

  getSnapshot(): RuntimeStateSnapshot {
    if (this.useRuntimeSnapshot) {
      return this.runtimeStateSource.getSnapshot();
    }
    return cloneRuntimeSnapshot(this.legacyRuntimeState);
  }

  shouldPersistLegacyCliState(): boolean {
    return !this.useRuntimeSnapshot;
  }

  applyLegacyCliState(payload: SavedConversationState): SavedConversationState {
    if (this.useRuntimeSnapshot) {
      return payload;
    }

    return {
      ...payload,
      cliAvailable: this.legacyRuntimeState.cliAvailable,
      cliVersion: this.legacyRuntimeState.cliVersion,
      cliDiagnostics: this.legacyRuntimeState.cliDiagnostics,
    };
  }

  setCliStatus(available: boolean, version: string | null, diagnostics?: string): void {
    if (this.useRuntimeSnapshot) {
      this.runtimeStateSource.setCliStatus(available, version, diagnostics);
      return;
    }

    this.legacyRuntimeState = {
      ...this.legacyRuntimeState,
      cliAvailable: available,
      cliVersion: version,
      cliDiagnostics: diagnostics ?? null,
    };
  }

  setWorkspaceFolders(folders: Array<{ uri: string; name: string }>): void {
    if (this.useRuntimeSnapshot) {
      this.runtimeStateSource.setWorkspaceFolders(folders);
      return;
    }

    this.legacyRuntimeState = {
      ...this.legacyRuntimeState,
      workspaceFolders: [...folders],
      isMultiRoot: folders.length > 1,
    };
  }

  setStreaming(streaming: boolean): void {
    if (this.useRuntimeSnapshot) {
      this.runtimeStateSource.setStreaming(streaming);
      return;
    }

    this.legacyRuntimeState = {
      ...this.legacyRuntimeState,
      isStreaming: streaming,
    };
  }
}
