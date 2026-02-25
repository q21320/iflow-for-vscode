import { IDEContext } from '../protocol';
import { IDEContextService } from './ideContextService';

export interface IDEContextSyncServiceDeps {
  postContextMessage(context: IDEContext): void;
  debug(message: string): void;
}

export class IDEContextSyncService {
  constructor(private readonly deps: IDEContextSyncServiceDeps) {}

  push(maxSelectionChars: number): void {
    const context = IDEContextService.build(maxSelectionChars);
    this.deps.debug(
      `Pushing IDE context: activeFile=${context.activeFile?.path ?? 'none'}, hasSelection=${Boolean(context.selection)}`
    );
    this.deps.postContextMessage(context);
  }
}
