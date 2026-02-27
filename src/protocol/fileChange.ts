export type RoundFileChangeKind = 'created' | 'modified' | 'deleted';
export type RoundFileChangeStatus = 'pending' | 'accepted' | 'reverted';

export interface RoundFileChange {
  path: string;
  displayPath: string;
  added: number;
  removed: number;
  kind: RoundFileChangeKind;
  status: RoundFileChangeStatus;
}

export interface RoundFileChangeSummary {
  conversationId: string;
  assistantMessageId: string;
  changedFiles: RoundFileChange[];
  totalAdded: number;
  totalRemoved: number;
  timestamp: number;
}
