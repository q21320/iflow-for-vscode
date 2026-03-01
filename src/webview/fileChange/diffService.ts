import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { RoundFileChange, RoundFileChangeSummary } from "../../protocol";
import {
  DIFF_SCHEME,
  DiffUriContext,
  FileChangeActionParams,
  FileChangeReviewServiceDeps,
  FileSnapshot,
  FileChangeStatus,
  MAX_VIRTUAL_DOCS,
  SnapshotMap,
  SummaryMap,
  VIRTUAL_URI_PARSE_AVAILABLE,
} from "./types";

export class FileChangeDiffService {
  constructor(
    private readonly deps: FileChangeReviewServiceDeps,
    private readonly virtualContents: Map<string, string>,
    private readonly latestSummaryByConversationId: SummaryMap,
    private readonly latestSnapshotsByConversationId: SnapshotMap,
  ) {}

  async handleAction(
    params: FileChangeActionParams,
  ): Promise<RoundFileChangeSummary> {
    switch (params.action) {
      case "openDiff":
        await this.openDiff(
          params.conversationId,
          params.assistantMessageId,
          params.path,
        );
        return this.getSummaryOrThrow(
          params.conversationId,
          params.assistantMessageId,
        );

      case "approve":
        return this.updateStatus(
          params.conversationId,
          params.assistantMessageId,
          params.path,
          "accepted",
        );

      case "rollback":
        await this.rollbackFile(
          params.conversationId,
          params.assistantMessageId,
          params.path,
        );
        return this.updateStatus(
          params.conversationId,
          params.assistantMessageId,
          params.path,
          "reverted",
        );
    }
  }

  updateStatus(
    conversationId: string,
    assistantMessageId: string,
    absolutePath: string,
    status: FileChangeStatus,
  ): RoundFileChangeSummary {
    const summary = this.getSummaryOrThrow(conversationId, assistantMessageId);
    const changedFiles = summary.changedFiles.map((entry) =>
      entry.path === absolutePath ? { ...entry, status } : entry,
    );

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

  getSummaryOrThrow(
    conversationId: string,
    assistantMessageId: string,
  ): RoundFileChangeSummary {
    const summary = this.latestSummaryByConversationId.get(conversationId);
    if (!summary || summary.assistantMessageId !== assistantMessageId) {
      throw new Error(
        "No file-change summary available for this conversation round",
      );
    }
    return summary;
  }

  getSnapshotOrThrow(
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

  async rollbackFile(
    conversationId: string,
    assistantMessageId: string,
    absolutePath: string,
  ): Promise<void> {
    const snapshot = this.getSnapshotOrThrow(
      conversationId,
      assistantMessageId,
      absolutePath,
    );

    if (snapshot.existedBefore) {
      await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.promises.writeFile(
        absolutePath,
        snapshot.beforeContent,
        "utf-8",
      );
      return;
    }

    if (fs.existsSync(absolutePath)) {
      await fs.promises.unlink(absolutePath);
    }
  }

  async openDiff(
    conversationId: string,
    assistantMessageId: string,
    absolutePath: string,
  ): Promise<void> {
    const snapshot = this.getSnapshotOrThrow(
      conversationId,
      assistantMessageId,
      absolutePath,
    );

    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const beforeUri = this.createVirtualOrTempUri({
      absolutePath,
      conversationId,
      assistantMessageId,
      side: "before",
      token,
      content: snapshot.beforeContent,
      tempFileName: `iflow-review-before-${token}-${path.basename(absolutePath)}`,
    });

    let afterUri: vscode.Uri;
    if (fs.existsSync(absolutePath)) {
      afterUri = vscode.Uri.file(absolutePath);
    } else {
      afterUri = this.createVirtualOrTempUri({
        absolutePath,
        conversationId,
        assistantMessageId,
        side: "after",
        token,
        content: "",
        tempFileName: `iflow-review-after-${token}-${path.basename(absolutePath)}`,
      });
    }

    this.pruneVirtualDocs();

    const title = `Rollback Preview: ${path.basename(absolutePath)}`;
    await this.deps.executeCommand("vscode.diff", beforeUri, afterUri, title);
  }

  createVirtualOrTempUri(ctx: DiffUriContext): vscode.Uri {
    if (VIRTUAL_URI_PARSE_AVAILABLE) {
      const uri = vscode.Uri.parse(
        `${DIFF_SCHEME}:/snapshot?path=${encodeURIComponent(ctx.absolutePath)}&conversation=${encodeURIComponent(ctx.conversationId)}&round=${encodeURIComponent(ctx.assistantMessageId)}&side=${ctx.side}&token=${ctx.token}`,
      );
      this.virtualContents.set(uri.toString(), ctx.content);
      return uri;
    }

    const tempPath = path.join(os.tmpdir(), ctx.tempFileName);
    fs.writeFileSync(tempPath, ctx.content, "utf-8");
    return vscode.Uri.file(tempPath);
  }

  pruneVirtualDocs(): void {
    if (this.virtualContents.size <= MAX_VIRTUAL_DOCS) {
      return;
    }

    const removeCount = this.virtualContents.size - MAX_VIRTUAL_DOCS;
    let removed = 0;
    for (const key of this.virtualContents.keys()) {
      this.virtualContents.delete(key);
      removed++;
      if (removed >= removeCount) {
        break;
      }
    }
  }
}
