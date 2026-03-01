import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AttachedFile, Conversation } from "../protocol";
import {
  WORKSPACE_FILE_LIST_DEFAULT_LIMIT,
  WORKSPACE_FILE_SEARCH_LIMIT,
} from "../constants/runtime";
import { isSubPath } from "../shared/pathUtils";
import { normalizeErrorMessage } from "../errorUtils";

export interface WorkspaceFileServiceDeps {
  getConfig<T>(key: string, defaultValue: T): T;
  getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] | undefined;
  getWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined;
  findFiles(
    include: string | vscode.GlobPattern,
    exclude?: string | vscode.GlobPattern | null,
    maxResults?: number,
    token?: vscode.CancellationToken,
  ): Thenable<vscode.Uri[]>;
  executeCommand<T>(
    command: string,
    ...rest: unknown[]
  ): Thenable<T | undefined>;
  debug(message: string): void;
}

interface WorkspaceFileSummary {
  path: string;
  name: string;
}

export class WorkspaceFileService {
  private canonicalRootsCache: string[] | null = null;

  constructor(private readonly deps: WorkspaceFileServiceDeps) {}

  invalidateCanonicalRootsCache(): void {
    this.canonicalRootsCache = null;
  }

  async listWorkspaceFiles(query: string): Promise<WorkspaceFileSummary[]> {
    const workspaceFolders = this.deps.getWorkspaceFolders();
    if (!workspaceFolders) {
      return [];
    }

    const safeQuery = query.replace(/[\\*?[\]{}]/g, "");
    const pattern = safeQuery ? `**/*${safeQuery}*` : "**/*";
    const excludePattern = "**/node_modules/**,**/.git/**,**/dist/**,**/out/**";

    const files = await this.deps.findFiles(
      pattern,
      excludePattern,
      WORKSPACE_FILE_SEARCH_LIMIT,
    );
    this.deps.debug(
      `Workspace file search: query="${safeQuery}", results=${files.length}`,
    );

    return files.map((file) => ({
      path: file.fsPath,
      name: path.basename(file.fsPath),
    }));
  }

  async readFiles(paths: string[]): Promise<AttachedFile[]> {
    const maxBytes = this.deps.getConfig<number>("maxFileBytes", 80000);
    const files: AttachedFile[] = [];
    this.deps.debug(
      `Reading attached files: count=${paths.length}, maxBytes=${maxBytes}`,
    );

    for (const filePath of paths) {
      try {
        const safePath = await this.validateWorkspacePath(filePath);
        const stat = await fs.promises.stat(safePath);
        const truncated = stat.size > maxBytes;

        let content: string;
        if (truncated) {
          const buffer = Buffer.alloc(maxBytes);
          const fd = await fs.promises.open(safePath, "r");
          try {
            const { bytesRead } = await fd.read(buffer, 0, maxBytes, 0);
            content = buffer.toString("utf-8", 0, bytesRead);
          } finally {
            await fd.close();
          }
        } else {
          content = await fs.promises.readFile(safePath, "utf-8");
        }

        files.push({ path: safePath, content, truncated });
      } catch (error) {
        const message = normalizeErrorMessage(error, "Error reading file");
        this.deps.debug(
          `Failed to read attached file: ${filePath}: ${message}`,
        );
        files.push({
          path: filePath,
          content: `[${message}]`,
          truncated: false,
        });
      }
    }

    return files;
  }

  async openFile(filePath: string): Promise<void> {
    const safePath = await this.validateWorkspacePath(filePath);
    await this.deps.executeCommand("vscode.open", vscode.Uri.file(safePath));
  }

  async getWorkspaceFileList(
    cwd?: string,
    limit = WORKSPACE_FILE_LIST_DEFAULT_LIMIT,
  ): Promise<string[]> {
    const workspaceFolders = this.deps.getWorkspaceFolders();
    if (!workspaceFolders) {
      return [];
    }

    const excludePattern = "**/node_modules/**,**/.git/**,**/dist/**,**/out/**";
    const normalizedLimit =
      Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : WORKSPACE_FILE_LIST_DEFAULT_LIMIT;
    const files = await this.deps.findFiles(
      "**/*",
      excludePattern,
      normalizedLimit,
    );

    const rootPath = cwd ?? workspaceFolders[0].uri.fsPath;

    if (workspaceFolders.length > 1) {
      return files.map((file) => {
        const folder = this.deps.getWorkspaceFolder(file);
        if (folder && folder.uri.fsPath === rootPath) {
          return path.relative(rootPath, file.fsPath);
        }
        return `[${folder?.name ?? "unknown"}] ${path.relative(folder?.uri.fsPath ?? "", file.fsPath)}`;
      });
    }

    return files.map((file) => path.relative(rootPath, file.fsPath));
  }

  syncWorkspaceFolders(): Array<{ uri: string; name: string }> {
    return (this.deps.getWorkspaceFolders() ?? []).map((folder) => ({
      uri: folder.uri.fsPath,
      name: folder.name,
    }));
  }

  resolveWorkspaceFolder(
    conversation: Conversation,
    activeEditor: vscode.TextEditor | undefined,
  ): string | undefined {
    const allFolders = this.deps.getWorkspaceFolders();
    if (!allFolders || allFolders.length === 0) {
      return undefined;
    }

    if (conversation.workspaceFolderUri) {
      const stillExists = allFolders.some(
        (folder) => folder.uri.fsPath === conversation.workspaceFolderUri,
      );
      if (stillExists) {
        return conversation.workspaceFolderUri;
      }
    }

    if (activeEditor && activeEditor.document.uri.scheme === "file") {
      const folder = this.deps.getWorkspaceFolder(activeEditor.document.uri);
      if (folder) {
        return folder.uri.fsPath;
      }
    }

    return allFolders[0].uri.fsPath;
  }

  getAllWorkspaceFolderPaths(): string[] {
    return (this.deps.getWorkspaceFolders() ?? []).map(
      (folder) => folder.uri.fsPath,
    );
  }

  private async validateWorkspacePath(filePath: string): Promise<string> {
    const workspaceFolders = this.deps.getWorkspaceFolders();
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error("Access denied: no workspace folder available");
    }

    const absolutePath = path.resolve(filePath);
    const canonicalTarget = await this.canonicalizePath(absolutePath);
    const canonicalRoots = await this.getCanonicalRoots(workspaceFolders);

    const isAllowed = canonicalRoots.some((root) =>
      isSubPath(root, canonicalTarget),
    );
    if (!isAllowed) {
      throw new Error(
        `Access denied: ${filePath} is outside workspace folders`,
      );
    }

    return canonicalTarget;
  }

  private async getCanonicalRoots(
    workspaceFolders: readonly vscode.WorkspaceFolder[],
  ): Promise<string[]> {
    if (!this.canonicalRootsCache) {
      this.canonicalRootsCache = await Promise.all(
        workspaceFolders.map((folder) =>
          this.canonicalizePath(folder.uri.fsPath),
        ),
      );
    }
    return this.canonicalRootsCache;
  }

  private async canonicalizePath(inputPath: string): Promise<string> {
    try {
      return await fs.promises.realpath(inputPath);
    } catch (error) {
      const message = normalizeErrorMessage(error);
      throw new Error(`Path does not exist: ${inputPath} (${message})`);
    }
  }
}
