import * as path from 'path';
import * as vscode from 'vscode';
import { diffLines } from 'diff';
import { RoundFileChange, RoundFileChangeSummary } from '../../protocol';

export interface FileSnapshot {
  absolutePath: string;
  displayPath: string;
  existedBefore: boolean;
  beforeContent: string;
}

export interface ActiveRunContext {
  conversationId: string;
  assistantMessageId: string;
  cwd?: string;
  allowedDirs: string[];
  snapshots: Map<string, FileSnapshot>;
  changedPaths: Set<string>;
  toolCallPaths: Map<string, string[]>;
  anonymousToolPaths: string[][];
}

export interface FileChangeRunStartContext {
  conversationId: string;
  assistantMessageId: string;
  cwd?: string;
  allowedDirs: string[];
}

export interface FileChangeRunFinalizeContext {
  conversationId: string;
  assistantMessageId: string;
  succeeded: boolean;
}

export interface FileChangeActionParams {
  action: 'openDiff' | 'approve' | 'rollback';
  conversationId: string;
  assistantMessageId: string;
  path: string;
}

export interface FileChangeReviewServiceDeps {
  executeCommand<T>(
    command: string,
    ...rest: unknown[]
  ): Thenable<T | undefined>;
  registerTextDocumentContentProvider(
    scheme: string,
    provider: vscode.TextDocumentContentProvider,
  ): vscode.Disposable;
  log(message: string): void;
}

export const DIFF_SCHEME = 'iflow-review-before';
export const MAX_VIRTUAL_DOCS = 120;
export const VIRTUAL_URI_PARSE_AVAILABLE =
  typeof (vscode.Uri as unknown as { parse?: unknown }).parse === 'function';

export function countChunkLines(value: string): number {
  if (!value) {
    return 0;
  }
  const matches = value.match(/\n/g);
  const newlineCount = matches ? matches.length : 0;
  if (value.endsWith('\n')) {
    return newlineCount;
  }
  return newlineCount + 1;
}

export function computeAddedRemoved(
  beforeContent: string,
  afterContent: string,
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;

  const changes = diffLines(beforeContent, afterContent);
  for (const change of changes) {
    const lineCount = change.count ?? countChunkLines(change.value);
    if (change.added) {
      added += lineCount;
    } else if (change.removed) {
      removed += lineCount;
    }
  }

  return { added, removed };
}

export function isSubPath(parentPath: string, childPath: string): boolean {
  const parent = process.platform === 'win32' ? parentPath.toLowerCase() : parentPath;
  const child = process.platform === 'win32' ? childPath.toLowerCase() : childPath;
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function normalizeMaybeArrayToStrings(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

export function parsePatchPaths(patchText: string): string[] {
  const results: string[] = [];
  const lines = patchText.split('\n');
  for (const line of lines) {
    if (line.startsWith('*** Update File: ')) {
      results.push(line.slice('*** Update File: '.length).trim());
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      results.push(line.slice('*** Add File: '.length).trim());
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      results.push(line.slice('*** Delete File: '.length).trim());
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match?.[2]) {
        results.push(match[2]);
      }
    }
  }
  return results;
}

export function isMutatingTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized.includes('write') ||
    normalized.includes('edit') ||
    normalized.includes('patch') ||
    normalized.includes('replace') ||
    normalized.includes('update') ||
    normalized.includes('modify') ||
    normalized.includes('rewrite') ||
    normalized.includes('delete') ||
    normalized.includes('remove') ||
    normalized.includes('fs/write_text_file') ||
    normalized.includes('fs/delete_text_file')
  );
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export type FileChangeStatus = RoundFileChange['status'];
export type SummaryMap = Map<string, RoundFileChangeSummary>;
export type SnapshotMap = Map<string, Map<string, FileSnapshot>>;
