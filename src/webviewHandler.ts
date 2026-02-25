import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConversationStore } from './store';
import { AcpClient } from './acpClient';
import { AuthService } from './authService';
import { WebviewMessage, ExtensionMessage, AttachedFile, IDEContext, Conversation } from './protocol';
import { CliStatusService } from './webview/cliStatusService';
import { IDEContextService } from './webview/ideContextService';
import { PlanModeOrchestrator } from './webview/planModeOrchestrator';
import { PlanApprovalCoordinator } from './webview/planApprovalCoordinator';
import { SendMessagePipeline } from './webview/sendMessagePipeline';
import { buildWebviewHtml } from './webview/htmlTemplate';
import { routeWebviewMessage } from './webview/messageRouter';

/**
 * Shared handler for webview message processing, CLI checking, and HTML generation.
 * Used by both IFlowPanel (independent panel) and IFlowSidebarProvider (sidebar view).
 */
export class WebviewHandler {
  private readonly store: ConversationStore;
  private readonly client: AcpClient;
  private readonly authService: AuthService;
  private readonly cliStatusService: CliStatusService;
  private readonly planApprovalCoordinator: PlanApprovalCoordinator;
  private readonly sendMessagePipeline: SendMessagePipeline;
  private readonly extensionUri: vscode.Uri;
  private webview: vscode.Webview | null = null;
  private disposables: vscode.Disposable[] = [];
  private selectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private outputChannel: vscode.OutputChannel | null = null;
  private static readonly SELECTION_DEBOUNCE_MS = 300;
  private static readonly MAX_SELECTION_CHARS = 5000;

  constructor(extensionUri: vscode.Uri, globalState: vscode.Memento, secrets: vscode.SecretStorage) {
    this.extensionUri = extensionUri;
    this.client = new AcpClient();
    this.authService = new AuthService(secrets);
    this.store = new ConversationStore(globalState, (state) => {
      this.postMessage({ type: 'stateUpdated', state });
    });

    this.cliStatusService = new CliStatusService(
      this.client,
      (result) => this.store.setCliStatus(result.version !== null, result.version, result.diagnostics),
      (message) => this.debug(message),
    );
    this.planApprovalCoordinator = new PlanApprovalCoordinator(new PlanModeOrchestrator());

    this.sendMessagePipeline = new SendMessagePipeline({
      store: this.store,
      client: this.client,
      postMessage: (message) => this.postMessage(message),
      markCliUnavailable: (diagnostics) => this.markCliUnavailable(diagnostics),
      resolveWorkspaceFolder: (conversation) => this.resolveWorkspaceFolder(conversation),
      getAllWorkspaceFolderPaths: () => this.getAllWorkspaceFolderPaths(),
      getWorkspaceFileList: async (cwd, limit) => this.getWorkspaceFileList(cwd, limit),
      shouldIncludeWorkspaceFiles: () => vscode.workspace.getConfiguration('iflow').get<boolean>('autoIncludeWorkspaceFiles', false),
      getWorkspaceFilesLimit: () => vscode.workspace.getConfiguration('iflow').get<number>('workspaceFilesLimit', 80),
      getStreamRenderIntervalMs: () => vscode.workspace.getConfiguration('iflow').get<number>('streamRenderIntervalMs', 50),
      planApprovalCoordinator: this.planApprovalCoordinator,
      debug: (message) => this.debug(message),
      setSessionId: (sessionId) => this.store.setSessionId(sessionId),
    });
  }

  /**
   * Bind this handler to a specific webview instance.
   * Call this when the webview becomes available.
   */
  bindWebview(webview: vscode.Webview): void {
    // Cleanup previous bindings
    this.disposeListeners();
    this.webview = webview;

    // Listen for messages from the webview
    const messageDisposable = webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message)
    );
    this.disposables.push(messageDisposable);

    // Re-check CLI availability when relevant settings change
    const configDisposable = vscode.workspace.onDidChangeConfiguration(
      async (e) => {
        if (e.affectsConfiguration('iflow.nodePath') ||
            e.affectsConfiguration('iflow.baseUrl') ||
            e.affectsConfiguration('iflow.port') ||
            e.affectsConfiguration('iflow.timeout') ||
            e.affectsConfiguration('iflow.enableCliStream')) {
          await this.client.dispose();
          CliStatusService.invalidateSharedCliCheck();
          await this.checkCliAvailability(true);
        }
      }
    );
    this.disposables.push(configDisposable);

    // Track active editor changes for IDE context
    const editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
      this.pushIDEContext();
    });
    this.disposables.push(editorDisposable);

    // Track selection changes (debounced)
    const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(() => {
      if (this.selectionDebounceTimer) {
        clearTimeout(this.selectionDebounceTimer);
      }
      this.selectionDebounceTimer = setTimeout(() => {
        this.selectionDebounceTimer = null;
        this.pushIDEContext();
      }, WebviewHandler.SELECTION_DEBOUNCE_MS);
    });
    this.disposables.push(selectionDisposable);

    // Initialize workspace folders and track changes
    this.syncWorkspaceFolders();
    const workspaceFolderDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.syncWorkspaceFolders();
    });
    this.disposables.push(workspaceFolderDisposable);
  }

  getStore(): ConversationStore {
    return this.store;
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    this.debug(`Received webview message: ${message.type}`);
    await routeWebviewMessage(message, {
      ready: async () => {
        this.syncWorkspaceFolders();
        this.postMessage({ type: 'stateUpdated', state: this.store.getState() });
        this.pushIDEContext();
      },
      recheckCli: async () => {
        await this.client.dispose();
        this.client.clearAutoDetectCache();
        CliStatusService.invalidateSharedCliCheck();
        await this.checkCliAvailability(true);
      },
      pickFiles: async () => this.handlePickFiles(),
      listWorkspaceFiles: async (msg) => this.handleListWorkspaceFiles(msg.query),
      readFiles: async (msg) => this.handleReadFiles(msg.paths),
      openFile: async (msg) => this.handleOpenFile(msg.path),
      newConversation: async () => {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        const folder = activeUri?.scheme === 'file'
          ? vscode.workspace.getWorkspaceFolder(activeUri)
          : undefined;
        this.store.newConversation(folder?.uri.fsPath);
      },
      switchConversation: async (msg) => this.store.switchConversation(msg.conversationId),
      deleteConversation: async (msg) => this.store.deleteConversation(msg.conversationId),
      clearConversation: async () => this.store.clearCurrentConversation(),
      setMode: async (msg) => this.store.setMode(msg.mode),
      setThink: async (msg) => this.store.setThink(msg.enabled),
      setModel: async (msg) => this.store.setModel(msg.model),
      setWorkspaceFolder: async (msg) => this.store.setConversationWorkspaceFolder(msg.uri),
      sendMessage: async (msg) => this.handleSendMessage(msg.content, msg.attachedFiles, false, msg.ideContext),
      toolApproval: async (msg) => {
        if (msg.outcome === 'reject') {
          await this.client.rejectToolCall(msg.requestId);
          await this.client.cancel();
          this.store.batchUpdate(() => {
            this.store.endAssistantMessage();
            this.store.setStreaming(false);
          });
          return;
        }
        await this.client.approveToolCall(msg.requestId, msg.outcome);
      },
      questionAnswer: async (msg) => this.client.answerQuestions(msg.requestId, msg.answers),
      planApproval: async (msg) => {
        if (msg.requestId === -1) {
          this.planApprovalCoordinator.registerSyntheticApproval(msg.option, msg.feedback);
          if (msg.option === 'smart' || msg.option === 'default') {
            this.store.setMode(msg.option);
          }
          return;
        }

        const approved = this.planApprovalCoordinator.registerServerApproval(msg.option, msg.feedback);
        await this.client.approvePlan(msg.requestId, approved);
      },
      cancelCurrent: async () => {
        await this.client.cancel();
        this.store.setStreaming(false);
        this.store.endAssistantMessage();
        this.planApprovalCoordinator.cancelWait();
      },
      startAuth: async () => this.handleStartAuth(),
    }, (unknownType) => {
      this.debug(`Unhandled webview message type: ${unknownType}`);
    });
  }

  private async checkCliAvailability(forceRefresh = false): Promise<void> {
    await this.cliStatusService.check(forceRefresh);
  }

  private async handleStartAuth(): Promise<void> {
    try {
      this.debug('Starting OAuth login flow');
      await this.authService.startLogin();
      vscode.window.showInformationMessage('iFlow: Login successful');
      this.debug('OAuth login flow completed successfully');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.debug(`OAuth login flow failed: ${msg}`);
      vscode.window.showErrorMessage(`iFlow login failed: ${msg}`);
    }
  }

  private async handlePickFiles(): Promise<void> {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach Files'
    });

    if (files) {
      this.debug(`Picked files count: ${files.length}`);
      this.postMessage({
        type: 'pickedFiles',
        files: files.map(f => ({
          path: f.fsPath,
          name: path.basename(f.fsPath)
        }))
      });
    }
  }

  private async handleListWorkspaceFiles(query: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      this.postMessage({ type: 'workspaceFiles', files: [] });
      return;
    }

    const safeQuery = query.replace(/[\\*?[\]{}]/g, '');
    const pattern = safeQuery ? `**/*${safeQuery}*` : '**/*';
    const excludePattern = '**/node_modules/**,**/.git/**,**/dist/**,**/out/**';

    const files = await vscode.workspace.findFiles(pattern, excludePattern, 50);
    this.debug(`Workspace file search: query="${safeQuery}", results=${files.length}`);

    this.postMessage({
      type: 'workspaceFiles',
      files: files.map(f => ({
        path: f.fsPath,
        name: path.basename(f.fsPath)
      }))
    });
  }

  private async handleReadFiles(paths: string[]): Promise<void> {
    const maxBytes = vscode.workspace.getConfiguration('iflow').get<number>('maxFileBytes', 80000);
    const files: AttachedFile[] = [];
    this.debug(`Reading attached files: count=${paths.length}, maxBytes=${maxBytes}`);

    for (const filePath of paths) {
      try {
        const safePath = await this.validateWorkspacePath(filePath);
        const stat = await fs.promises.stat(safePath);
        const truncated = stat.size > maxBytes;

        let content: string;
        if (truncated) {
          const buffer = Buffer.alloc(maxBytes);
          const fd = await fs.promises.open(safePath, 'r');
          try {
            const { bytesRead } = await fd.read(buffer, 0, maxBytes, 0);
            content = buffer.toString('utf-8', 0, bytesRead);
          } finally {
            await fd.close();
          }
        } else {
          content = await fs.promises.readFile(safePath, 'utf-8');
        }

        files.push({ path: safePath, content, truncated });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Error reading file';
        this.debug(`Failed to read attached file: ${filePath}: ${message}`);
        files.push({ path: filePath, content: `[${message}]`, truncated: false });
      }
    }

    this.postMessage({ type: 'fileContents', files });
  }

  private async handleOpenFile(filePath: string): Promise<void> {
    try {
      const safePath = await this.validateWorkspacePath(filePath);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(safePath));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.debug(`Failed to open file ${filePath}: ${msg}`);
    }
  }

  private async getWorkspaceFileList(cwd?: string, limit = 200): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return [];
    }

    const excludePattern = '**/node_modules/**,**/.git/**,**/dist/**,**/out/**';
    const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
    const files = await vscode.workspace.findFiles('**/*', excludePattern, normalizedLimit);

    const rootPath = cwd ?? workspaceFolders[0].uri.fsPath;

    // In multi-root, prefix files from non-active folders with folder name
    if (workspaceFolders.length > 1) {
      return files.map(f => {
        const folder = vscode.workspace.getWorkspaceFolder(f);
        if (folder && folder.uri.fsPath === rootPath) {
          return path.relative(rootPath, f.fsPath);
        }
        return `[${folder?.name ?? 'unknown'}] ${path.relative(folder?.uri.fsPath ?? '', f.fsPath)}`;
      });
    }

    return files.map(f => path.relative(rootPath, f.fsPath));
  }

  private async handleSendMessage(content: string, attachedFiles: AttachedFile[], silent = false, ideContext?: IDEContext): Promise<void> {
    await this.sendMessagePipeline.execute({
      content,
      attachedFiles,
      silent,
      ideContext,
    });
  }

  private markCliUnavailable(diagnostics: string): void {
    CliStatusService.cacheCliCheckResult({ version: null, diagnostics });
    this.store.setCliStatus(false, null, diagnostics);
  }

  private syncWorkspaceFolders(): void {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => ({
      uri: f.uri.fsPath,
      name: f.name,
    }));
    this.store.setWorkspaceFolders(folders);
    this.debug(`Synced workspace folders: count=${folders.length}`);
  }

  private resolveWorkspaceFolder(conversation: Conversation): string | undefined {
    const allFolders = vscode.workspace.workspaceFolders;
    if (!allFolders || allFolders.length === 0) {
      return undefined;
    }

    // Priority 1: Conversation's explicit workspace folder (if still valid)
    if (conversation.workspaceFolderUri) {
      const stillExists = allFolders.some(f => f.uri.fsPath === conversation.workspaceFolderUri);
      if (stillExists) {
        return conversation.workspaceFolderUri;
      }
    }

    // Priority 2: Folder containing the active editor file
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
      if (folder) {
        return folder.uri.fsPath;
      }
    }

    // Priority 3: First workspace folder
    return allFolders[0].uri.fsPath;
  }

  private getAllWorkspaceFolderPaths(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  }

  private pushIDEContext(): void {
    const context: IDEContext = IDEContextService.build(WebviewHandler.MAX_SELECTION_CHARS);
    this.debug(`Pushing IDE context: activeFile=${context.activeFile?.path ?? 'none'}, hasSelection=${Boolean(context.selection)}`);
    this.postMessage({ type: 'ideContextChanged', context });
  }

  postMessage(message: ExtensionMessage): void {
    this.webview?.postMessage(message);
  }

  getHtmlForWebview(webview: vscode.Webview): string {
    return buildWebviewHtml(this.extensionUri, webview);
  }

  private disposeListeners(): void {
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }

  async dispose(): Promise<void> {
    if (this.selectionDebounceTimer) {
      clearTimeout(this.selectionDebounceTimer);
      this.selectionDebounceTimer = null;
    }
    this.disposeListeners();
    await this.client.dispose();
    this.authService.dispose();
    this.debug('WebviewHandler disposed');
    this.outputChannel?.dispose();
    this.outputChannel = null;
    this.webview = null;
  }

  private debug(message: string): void {
    if (!vscode.workspace.getConfiguration('iflow').get<boolean>('debugLogging', false)) {
      return;
    }

    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel('IFlow Debug');
    }

    this.outputChannel.appendLine(`[WebviewHandler] ${message}`);
    console.debug(`[IFlow][WebviewHandler] ${message}`);
  }

  private async validateWorkspacePath(filePath: string): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error('Access denied: no workspace folder available');
    }

    const absolutePath = path.resolve(filePath);
    const canonicalTarget = await this.canonicalizePath(absolutePath);
    const canonicalRoots = await Promise.all(
      workspaceFolders.map((folder) => this.canonicalizePath(folder.uri.fsPath)),
    );

    const isAllowed = canonicalRoots.some((root) => this.isSubPath(root, canonicalTarget));
    if (!isAllowed) {
      throw new Error(`Access denied: ${filePath} is outside workspace folders`);
    }

    return canonicalTarget;
  }

  private async canonicalizePath(inputPath: string): Promise<string> {
    try {
      return await fs.promises.realpath(inputPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Path does not exist: ${inputPath} (${message})`);
    }
  }

  private isSubPath(parentPath: string, childPath: string): boolean {
    const parent = process.platform === 'win32' ? parentPath.toLowerCase() : parentPath;
    const child = process.platform === 'win32' ? childPath.toLowerCase() : childPath;
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }
}
