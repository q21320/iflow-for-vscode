import * as vscode from 'vscode';
import { SavedConversationState } from './storeTypes';

const STORAGE_KEY = 'iflow.conversations';

export class ConversationRepository {
  constructor(private readonly memento: vscode.Memento) {}

  load(): SavedConversationState | undefined {
    return this.memento.get<SavedConversationState>(STORAGE_KEY);
  }

  save(payload: SavedConversationState): void {
    void this.memento.update(STORAGE_KEY, payload);
  }
}
