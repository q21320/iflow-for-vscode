import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  RoundFileChange,
  RoundFileChangeSummary,
  StreamChunk,
} from '../protocol';
import { FileChangeChunkTracker } from './fileChange/chunkTracker';
import { FileChangeDiffService } from './fileChange/diffService';
import { SnapshotManager } from './fileChange/snapshotManager';
import {
  ActiveRunContext,
  computeAddedRemoved,
  DIFF_SCHEME,
  FileChangeActionParams,
  FileChangeReviewServiceDeps,
  FileChangeRunFinalizeContext,
  FileChangeRunStartContext,
  FileSnapshot,
} from './fileChange/types';

export type {
  FileChangeReviewServiceDeps,
  FileChangeRunFinalizeContext,
  FileChangeRunStartContext,
} from './fileChange/types';

export class FileChangeReviewService {
  private readonly virtualContents = new Map<string, string>();
  private readonly latestSummaryByConversationId = new Map<
    string,
    RoundFileChangeSummary
  >();
  private readonly latestSnapshotsByConversationId = new Map<
    string,
    Map<string, FileSnapshot>
  >();
  private readonly providerDisposable: vscode.Disposable;
  private readonly snapshotManager = new SnapshotManager();
  private readonly chunkTracker = new FileChangeChunkTracker(this.snapshotManager);
  private readonly diffService: FileChangeDiffService;
  private activeRun: ActiveRunContext | null = null;

  constructor(private readonly deps: FileChangeReviewServiceDeps) {
    this.providerDisposable = this.deps.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      {
        provideTextDocumentContent: (uri) =>
          this.virtualContents.get(uri.toString()) ?? '',
      },
    );
    this.diffService = new FileChangeDiffService(
      this.deps,
      this.virtualContents,
      this.latestSummaryByConversationId,
      this.latestSnapshotsByConversationId,
    );
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
      this.chunkTracker.onChunk(this.activeRun, chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log(`File change tracker chunk handling failed: ${message}`);
    }
  }

  finalizeRun(context: FileChangeRunFinalizeContext): RoundFileChangeSummary {
    const active = this.activeRun;
    this.activeRun = null;

    if (
      !active ||
      active.conversationId !== context.conversationId ||
      active.assistantMessageId !== context.assistantMessageId
    ) {
      const fallback: RoundFileChangeSummary = {
        conversationId: context.conversationId,
        assistantMessageId: context.assistantMessageId,
        changedFiles: [],
        totalAdded: 0,
        totalRemoved: 0,
        timestamp: Date.now(),
      };
      this.latestSummaryByConversationId.set(context.conversationId, fallback);
      this.latestSnapshotsByConversationId.set(
        context.conversationId,
        new Map<string, FileSnapshot>(),
      );
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
        ? existsNow
          ? 'modified'
          : 'deleted'
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
    const totalAdded = changedFiles.reduce(
      (sum, entry) => sum + entry.added,
      0,
    );
    const totalRemoved = changedFiles.reduce(
      (sum, entry) => sum + entry.removed,
      0,
    );

    const summary: RoundFileChangeSummary = {
      conversationId: context.conversationId,
      assistantMessageId: context.assistantMessageId,
      changedFiles,
      totalAdded,
      totalRemoved,
      timestamp: Date.now(),
    };

    this.latestSummaryByConversationId.set(context.conversationId, summary);
    this.latestSnapshotsByConversationId.set(
      context.conversationId,
      snapshotsForSummary,
    );
    return summary;
  }

  async handleAction(
    params: FileChangeActionParams,
  ): Promise<RoundFileChangeSummary> {
    return this.diffService.handleAction(params);
  }
}
