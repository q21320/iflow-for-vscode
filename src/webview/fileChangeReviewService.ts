import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RoundFileChange, RoundFileChangeSummary, StreamChunk } from '../protocol';

interface FileSnapshot {
  absolutePath: string;
  displayPath: string;
  existedBefore: boolean;
  beforeContent: string;
}

interface ActiveRunContext {
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

interface FileChangeActionParams {
  action: 'openDiff' | 'approve' | 'rollback';
  conversationId: string;
  assistantMessageId: string;
  path: string;
}

export interface FileChangeReviewServiceDeps {
  executeCommand<T>(command: string, ...rest: unknown[]): Thenable<T | undefined>;
  registerTextDocumentContentProvider(
    scheme: string,
    provider: vscode.TextDocumentContentProvider,
  ): vscode.Disposable;
  log(message: string): void;
}

const DIFF_SCHEME = 'iflow-review-before';
const MAX_VIRTUAL_DOCS = 120;
const VIRTUAL_URI_PARSE_AVAILABLE = typeof (vscode.Uri as unknown as { parse?: unknown }).parse === 'function';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function splitLines(content: string): string[] {
  if (!content) {
    return [];
  }
  return content.split(/\r?\n/);
}

function computeShortestEditDistance(beforeLines: string[], afterLines: string[]): number {
  const n = beforeLines.length;
  const m = afterLines.length;
  if (n === 0) {
    return m;
  }
  if (m === 0) {
    return n;
  }

  const max = n + m;
  const offset = max;
  const v: number[] = new Array((max * 2) + 1).fill(0);
  v[offset + 1] = 0;

  for (let d = 0; d <= max; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      const index = offset + k;
      let x: number;
      if (k === -d || (k !== d && v[index - 1] < v[index + 1])) {
        x = v[index + 1];
      } else {
        x = v[index - 1] + 1;
      }

      let y = x - k;
      while (x < n && y < m && beforeLines[x] === afterLines[y]) {
        x += 1;
        y += 1;
      }
      v[index] = x;

      if (x >= n && y >= m) {
        return d;
      }
    }
  }

  return max;
}

function computeAddedRemoved(beforeContent: string, afterContent: string): { added: number; removed: number } {
  const beforeLines = splitLines(beforeContent);
  const afterLines = splitLines(afterContent);
  const delta = afterLines.length - beforeLines.length;
  const shortestDistance = computeShortestEditDistance(beforeLines, afterLines);
  const added = Math.max(0, Math.round((shortestDistance + delta) / 2));
  const removed = Math.max(0, Math.round((shortestDistance - delta) / 2));
  return { added, removed };
}

function isSubPath(parentPath: string, childPath: string): boolean {
  const parent = process.platform === 'win32' ? parentPath.toLowerCase() : parentPath;
  const child = process.platform === 'win32' ? childPath.toLowerCase() : childPath;
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeMaybeArrayToStrings(value: unknown): string[] {
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

function parsePatchPaths(patchText: string): string[] {
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

function isMutatingTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.includes('write')
    || normalized.includes('edit')
    || normalized.includes('patch')
    || normalized.includes('replace')
    || normalized.includes('update')
    || normalized.includes('modify')
    || normalized.includes('rewrite')
    || normalized.includes('delete')
    || normalized.includes('remove')
    || normalized.includes('fs/write_text_file')
    || normalized.includes('fs/delete_text_file');
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export class FileChangeReviewService {
  private readonly virtualContents = new Map<string, string>();
  private readonly latestSummaryByConversationId = new Map<string, RoundFileChangeSummary>();
  private readonly latestSnapshotsByConversationId = new Map<string, Map<string, FileSnapshot>>();
  private readonly providerDisposable: vscode.Disposable;
  private activeRun: ActiveRunContext | null = null;

  constructor(private readonly deps: FileChangeReviewServiceDeps) {
    this.providerDisposable = this.deps.registerTextDocumentContentProvider(DIFF_SCHEME, {
      provideTextDocumentContent: (uri) => this.virtualContents.get(uri.toString()) ?? '',
    });
  }

  dispose(): void {
    this.providerDisposable.dispose();
    this.virtualContents.clear();
    this.latestSummaryByConversationId.clear();
    this.latestSnapshotsByConversationId.clear();
    this.activeRun = null;
  }

  startRun(context: FileChangeRunStartContext): void {
    this.activeRun = {
      conversationId: context.conversationId,
      assistantMessageId: context.assistantMessageId,
      cwd: context.cwd,
      allowedDirs: context.allowedDirs.map((entry) => path.resolve(entry)),
      snapshots: new Map<string, FileSnapshot>(),
      changedPaths: new Set<string>(),
      toolCallPaths: new Map<string, string[]>(),
      anonymousToolPaths: [],
    };
  }

  onChunk(chunk: StreamChunk): void {
    if (!this.activeRun) {
      return;
    }

    try {
      if (chunk.chunkType === 'tool_start') {
        this.handleToolStart(chunk);
        return;
      }

      if (chunk.chunkType === 'tool_end') {
        this.handleToolEnd(chunk);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log(`File change tracker chunk handling failed: ${message}`);
    }
  }

  finalizeRun(context: FileChangeRunFinalizeContext): RoundFileChangeSummary {
    const active = this.activeRun;
    this.activeRun = null;

    if (!active
      || active.conversationId !== context.conversationId
      || active.assistantMessageId !== context.assistantMessageId) {
      const fallback: RoundFileChangeSummary = {
        conversationId: context.conversationId,
        assistantMessageId: context.assistantMessageId,
        changedFiles: [],
        totalAdded: 0,
        totalRemoved: 0,
        timestamp: Date.now(),
      };
      this.latestSummaryByConversationId.set(context.conversationId, fallback);
      this.latestSnapshotsByConversationId.set(context.conversationId, new Map<string, FileSnapshot>());
      return fallback;
    }

    const changedFiles: RoundFileChange[] = [];
    const snapshotsForSummary = new Map<string, FileSnapshot>();

    for (const filePath of active.changedPaths) {
      const snapshot = active.snapshots.get(filePath);
      if (!snapshot) {
        continue;
      }

      const existsNow = fs.existsSync(filePath);
      const afterContent = existsNow ? fs.readFileSync(filePath, 'utf-8') : '';
      const kind: RoundFileChange['kind'] = snapshot.existedBefore
        ? (existsNow ? 'modified' : 'deleted')
        : 'created';
      const stats = computeAddedRemoved(snapshot.beforeContent, afterContent);

      if (kind === 'modified' && stats.added === 0 && stats.removed === 0) {
        continue;
      }

      changedFiles.push({
        path: filePath,
        displayPath: snapshot.displayPath,
        added: stats.added,
        removed: stats.removed,
        kind,
        status: 'pending',
      });
      snapshotsForSummary.set(filePath, snapshot);
    }

    changedFiles.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
    const totalAdded = changedFiles.reduce((sum, entry) => sum + entry.added, 0);
    const totalRemoved = changedFiles.reduce((sum, entry) => sum + entry.removed, 0);

    const summary: RoundFileChangeSummary = {
      conversationId: context.conversationId,
      assistantMessageId: context.assistantMessageId,
      changedFiles,
      totalAdded,
      totalRemoved,
      timestamp: Date.now(),
    };

    this.latestSummaryByConversationId.set(context.conversationId, summary);
    this.latestSnapshotsByConversationId.set(context.conversationId, snapshotsForSummary);
    return summary;
  }

  async handleAction(params: FileChangeActionParams): Promise<RoundFileChangeSummary> {
    switch (params.action) {
      case 'openDiff':
        await this.openDiff(params.conversationId, params.assistantMessageId, params.path);
        return this.getSummaryOrThrow(params.conversationId, params.assistantMessageId);
      case 'approve':
        return this.updateStatus(params.conversationId, params.assistantMessageId, params.path, 'accepted');
      case 'rollback':
        await this.rollbackFile(params.conversationId, params.assistantMessageId, params.path);
        return this.updateStatus(params.conversationId, params.assistantMessageId, params.path, 'reverted');
    }
  }

  private handleToolStart(chunk: Extract<StreamChunk, { chunkType: 'tool_start' }>): void {
    if (!this.activeRun || !isMutatingTool(chunk.name)) {
      return;
    }

    const candidates = this.extractPathsFromToolInput(chunk.input);
    const normalized = unique(candidates
      .map((entry) => this.normalizeCandidatePath(entry))
      .filter((entry): entry is string => Boolean(entry)));

    if (normalized.length === 0) {
      return;
    }

    for (const filePath of normalized) {
      this.captureSnapshotIfNeeded(filePath);
    }

    if (chunk.toolCallId) {
      this.activeRun.toolCallPaths.set(chunk.toolCallId, normalized);
      return;
    }

    this.activeRun.anonymousToolPaths.push(normalized);
  }

  private handleToolEnd(chunk: Extract<StreamChunk, { chunkType: 'tool_end' }>): void {
    if (!this.activeRun || chunk.status !== 'completed') {
      return;
    }

    let filePaths: string[] | undefined;
    if (chunk.toolCallId) {
      filePaths = this.activeRun.toolCallPaths.get(chunk.toolCallId);
      this.activeRun.toolCallPaths.delete(chunk.toolCallId);
    } else {
      filePaths = this.activeRun.anonymousToolPaths.pop();
    }

    if (!filePaths) {
      return;
    }

    for (const filePath of filePaths) {
      this.activeRun.changedPaths.add(filePath);
    }
  }

  private extractPathsFromToolInput(input: Record<string, unknown>): string[] {
    const paths: string[] = [];
    const directPathKeys = [
      'file_path',
      'filePath',
      'path',
      'absolute_path',
      'file',
      'target_file',
    ];

    for (const key of directPathKeys) {
      paths.push(...normalizeMaybeArrayToStrings(input[key]));
    }

    for (const value of Object.values(input)) {
      if (typeof value === 'string') {
        paths.push(...parsePatchPaths(value));
      }
    }

    return unique(paths);
  }

  private normalizeCandidatePath(candidate: string): string | null {
    if (!this.activeRun) {
      return null;
    }
    if (!candidate) {
      return null;
    }

    const absolutePath = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(this.activeRun.cwd ?? '', candidate);

    if (!this.isAllowedPath(absolutePath)) {
      return null;
    }

    return absolutePath;
  }

  private isAllowedPath(absolutePath: string): boolean {
    if (!this.activeRun) {
      return false;
    }
    return this.activeRun.allowedDirs.some((allowedDir) => isSubPath(allowedDir, absolutePath));
  }

  private captureSnapshotIfNeeded(absolutePath: string): void {
    if (!this.activeRun || this.activeRun.snapshots.has(absolutePath)) {
      return;
    }

    const existedBefore = fs.existsSync(absolutePath);
    const beforeContent = existedBefore ? fs.readFileSync(absolutePath, 'utf-8') : '';
    const displayPath = this.getDisplayPath(absolutePath);
    this.activeRun.snapshots.set(absolutePath, {
      absolutePath,
      displayPath,
      existedBefore,
      beforeContent,
    });
  }

  private getDisplayPath(absolutePath: string): string {
    if (!this.activeRun) {
      return absolutePath;
    }

    const candidates: string[] = [];
    if (this.activeRun.cwd && isSubPath(this.activeRun.cwd, absolutePath)) {
      candidates.push(path.relative(this.activeRun.cwd, absolutePath));
    }

    for (const allowedDir of this.activeRun.allowedDirs) {
      if (isSubPath(allowedDir, absolutePath)) {
        candidates.push(path.relative(allowedDir, absolutePath));
      }
    }

    const filtered = candidates.filter((entry) => Boolean(entry) && !entry.startsWith('..'));
    if (filtered.length > 0) {
      filtered.sort((a, b) => a.length - b.length);
      return filtered[0];
    }
    return absolutePath;
  }

  private getSummaryOrThrow(conversationId: string, assistantMessageId: string): RoundFileChangeSummary {
    const summary = this.latestSummaryByConversationId.get(conversationId);
    if (!summary || summary.assistantMessageId !== assistantMessageId) {
      throw new Error('No file-change summary available for this conversation round');
    }
    return summary;
  }

  private getSnapshotOrThrow(
    conversationId: string,
    assistantMessageId: string,
    absolutePath: string,
  ): FileSnapshot {
    this.getSummaryOrThrow(conversationId, assistantMessageId);
    const snapshots = this.latestSnapshotsByConversationId.get(conversationId);
    const snapshot = snapshots?.get(absolutePath);
    if (!snapshot) {
      throw new Error(`No snapshot found for ${absolutePath}`);
    }
    return snapshot;
  }

  private updateStatus(
    conversationId: string,
    assistantMessageId: string,
    absolutePath: string,
    status: RoundFileChange['status'],
  ): RoundFileChangeSummary {
    const summary = this.getSummaryOrThrow(conversationId, assistantMessageId);
    const changedFiles = summary.changedFiles.map((entry) => (
      entry.path === absolutePath
        ? { ...entry, status }
        : entry
    ));

    if (!changedFiles.some((entry) => entry.path === absolutePath)) {
      throw new Error(`File ${absolutePath} not found in latest round summary`);
    }

    const updated: RoundFileChangeSummary = {
      ...summary,
      changedFiles,
      timestamp: Date.now(),
    };
    this.latestSummaryByConversationId.set(conversationId, updated);
    return updated;
  }

  private async rollbackFile(
    conversationId: string,
    assistantMessageId: string,
    absolutePath: string,
  ): Promise<void> {
    const snapshot = this.getSnapshotOrThrow(conversationId, assistantMessageId, absolutePath);
    if (snapshot.existedBefore) {
      await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.promises.writeFile(absolutePath, snapshot.beforeContent, 'utf-8');
      return;
    }

    if (fs.existsSync(absolutePath)) {
      await fs.promises.unlink(absolutePath);
    }
  }

  private async openDiff(
    conversationId: string,
    assistantMessageId: string,
    absolutePath: string,
  ): Promise<void> {
    const snapshot = this.getSnapshotOrThrow(conversationId, assistantMessageId, absolutePath);
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const beforeUri = this.createVirtualOrTempUri(
      absolutePath,
      conversationId,
      assistantMessageId,
      'before',
      token,
      snapshot.beforeContent,
      `iflow-review-before-${token}-${path.basename(absolutePath)}`,
    );

    let afterUri: vscode.Uri;
    if (fs.existsSync(absolutePath)) {
      afterUri = vscode.Uri.file(absolutePath);
    } else {
      afterUri = this.createVirtualOrTempUri(
        absolutePath,
        conversationId,
        assistantMessageId,
        'after',
        token,
        '',
        `iflow-review-after-${token}-${path.basename(absolutePath)}`,
      );
    }

    this.pruneVirtualDocs();

    const title = `Rollback Preview: ${path.basename(absolutePath)}`;
    await this.deps.executeCommand('vscode.diff', beforeUri, afterUri, title);
  }

  private createVirtualOrTempUri(
    absolutePath: string,
    conversationId: string,
    assistantMessageId: string,
    side: 'before' | 'after',
    token: string,
    content: string,
    tempFileName: string,
  ): vscode.Uri {
    if (VIRTUAL_URI_PARSE_AVAILABLE) {
      const uri = vscode.Uri.parse(
        `${DIFF_SCHEME}:/snapshot?path=${encodeURIComponent(absolutePath)}&conversation=${encodeURIComponent(conversationId)}&round=${encodeURIComponent(assistantMessageId)}&side=${side}&token=${token}`,
      );
      this.virtualContents.set(uri.toString(), content);
      return uri;
    }

    const tempPath = path.join(os.tmpdir(), tempFileName);
    fs.writeFileSync(tempPath, content, 'utf-8');
    return vscode.Uri.file(tempPath);
  }

  private pruneVirtualDocs(): void {
    if (this.virtualContents.size <= MAX_VIRTUAL_DOCS) {
      return;
    }

    const removeCount = this.virtualContents.size - MAX_VIRTUAL_DOCS;
    const keys = Array.from(this.virtualContents.keys()).slice(0, removeCount);
    for (const key of keys) {
      this.virtualContents.delete(key);
    }
  }
}
