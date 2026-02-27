import { ConversationState } from '../protocol';

export interface RuntimeStateSnapshot {
  cliAvailable: ConversationState['cliAvailable'];
  cliVersion: ConversationState['cliVersion'];
  cliDiagnostics: ConversationState['cliDiagnostics'];
  isStreaming: ConversationState['isStreaming'];
  workspaceFolders: ConversationState['workspaceFolders'];
  isMultiRoot: ConversationState['isMultiRoot'];
}

export const INITIAL_RUNTIME_STATE_SNAPSHOT: RuntimeStateSnapshot = {
  cliAvailable: true,
  cliVersion: null,
  cliDiagnostics: null,
  isStreaming: false,
  workspaceFolders: [],
  isMultiRoot: false,
};

function cloneWorkspaceFolders(
  folders: ConversationState['workspaceFolders'],
): ConversationState['workspaceFolders'] {
  return folders.map((folder) => ({ uri: folder.uri, name: folder.name }));
}

function cloneRuntimeStateSnapshot(snapshot: RuntimeStateSnapshot): RuntimeStateSnapshot {
  return {
    ...snapshot,
    workspaceFolders: cloneWorkspaceFolders(snapshot.workspaceFolders),
  };
}

export class RuntimeStateSource {
  private snapshot: RuntimeStateSnapshot;

  constructor(initial?: Partial<RuntimeStateSnapshot>) {
    const merged: RuntimeStateSnapshot = {
      ...INITIAL_RUNTIME_STATE_SNAPSHOT,
      ...initial,
      workspaceFolders: cloneWorkspaceFolders(initial?.workspaceFolders ?? []),
    };
    merged.isMultiRoot = merged.workspaceFolders.length > 1;
    this.snapshot = merged;
  }

  getSnapshot(): RuntimeStateSnapshot {
    return cloneRuntimeStateSnapshot(this.snapshot);
  }

  replace(snapshot: RuntimeStateSnapshot): void {
    this.snapshot = cloneRuntimeStateSnapshot(snapshot);
  }

  setCliStatus(
    available: boolean,
    version: string | null,
    diagnostics?: string,
  ): void {
    this.snapshot = {
      ...this.snapshot,
      cliAvailable: available,
      cliVersion: version,
      cliDiagnostics: diagnostics ?? null,
    };
  }

  setStreaming(streaming: boolean): void {
    this.snapshot = {
      ...this.snapshot,
      isStreaming: streaming,
    };
  }

  setWorkspaceFolders(folders: ConversationState['workspaceFolders']): void {
    const cloned = cloneWorkspaceFolders(folders);
    this.snapshot = {
      ...this.snapshot,
      workspaceFolders: cloned,
      isMultiRoot: cloned.length > 1,
    };
  }
}
