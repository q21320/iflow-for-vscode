// AcpClient: ACP session lifecycle + public API facade.
// Implements ACP (WebSocket + JSON-RPC 2.0) without SDK dependency.

import * as vscode from 'vscode';
import { StreamChunk } from './protocol';
import { ChunkMapper } from './chunkMapper';
import { AcpTransport } from './acpTransport';
import { AcpProtocol } from './acpProtocol';
import { ProcessManager } from './processManager';
import { InteractionBridge } from './acp/interactionBridge';
import { normalizeErrorMessage } from './errorUtils';
import { PathPolicy } from './acp/pathPolicy';
import { RuntimeConfigApplier } from './acp/runtimeConfigApplier';
import { SessionCoordinator } from './acp/sessionCoordinator';
import { SettingsRepository } from './acp/settingsRepository';
import { ConnectionSnapshot, RunOptions } from './acp/types';

interface AcpNotificationEnvelope {
  sessionId?: string;
  update?: unknown;
  usageMetadata?: unknown;
  usage?: unknown;
  tokenUsage?: unknown;
}

const ACP_DEBUG_LOG_MAX_CHARS = 8000;

/** Read a vscode config value with fallback. */
function getConfig<T>(key: string, defaultValue: T): T {
  return vscode.workspace.getConfiguration('iflow').get<T>(key, defaultValue);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class AcpClient {
  private running = false;
  private activeChunkSink: ((chunk: StreamChunk) => void) | null = null;
  private readonly chunkMapper: ChunkMapper;
  private processManager: ProcessManager;
  private readonly settingsRepository: SettingsRepository;
  private readonly pathPolicy: PathPolicy;
  private readonly runtimeConfigApplier: RuntimeConfigApplier;
  private readonly interactionBridge: InteractionBridge;
  private readonly sessionCoordinator: SessionCoordinator;
  private outputChannel: vscode.OutputChannel | null = null;

  constructor() {
    this.chunkMapper = new ChunkMapper((msg) => this.log(msg));
    this.processManager = new ProcessManager(
      (msg) => this.log(msg),
      (msg) => this.log(msg),
    );

    this.settingsRepository = new SettingsRepository((msg) => this.log(msg));
    this.pathPolicy = new PathPolicy();
    this.runtimeConfigApplier = new RuntimeConfigApplier((msg) => this.log(msg));
    this.interactionBridge = new InteractionBridge(
      (chunk) => this.emitChunk(chunk),
      (rawPath) => this.pathPolicy.ensureAllowedPath(rawPath),
      (msg) => this.log(msg),
      {
        interactionTimeoutMs: getConfig<number>('interactionTimeoutMs', 120000),
      },
    );

    this.sessionCoordinator = new SessionCoordinator({
      createTransport: () => this._createTransport(),
      createProtocol: (transport) => this._createProtocol(transport),
      getProcessManager: () => this.processManager,
      getConfig,
      runtimeConfigApplier: this.runtimeConfigApplier,
      interactionBridge: this.interactionBridge,
      log: (msg) => this.log(msg),
      onConnectionStateChange: (snapshot, reason, error) =>
        this.handleConnectionStateChange(snapshot, reason, error),
    });
  }

  // Backward-compat test hooks for legacy unit tests.
  get pendingPermissions(): Map<number, unknown> {
    return this.interactionBridge.getPendingInteractionsForTests() as unknown as Map<number, unknown>;
  }

  set pendingPermissions(map: Map<number, unknown>) {
    this.interactionBridge.replacePendingInteractionsForTests(
      map as unknown as ReturnType<InteractionBridge['getPendingInteractionsForTests']>
    );
  }

  get protocol(): AcpProtocol | null {
    return this.sessionCoordinator.currentProtocol;
  }

  set protocol(protocol: AcpProtocol | null) {
    this.sessionCoordinator.setConnectionForTests({ protocol });
  }

  get isConnected(): boolean {
    return this.sessionCoordinator.currentIsConnected;
  }

  set isConnected(isConnected: boolean) {
    this.sessionCoordinator.setConnectionForTests({ isConnected });
  }

  get sessionId(): string | null {
    return this.sessionCoordinator.currentSessionId;
  }

  set sessionId(sessionId: string | null) {
    this.sessionCoordinator.setConnectionForTests({ sessionId });
  }

  // ── Factory methods (overridable for tests) ─────────────────────────

  /** Create the WebSocket transport layer. */
  _createTransport(): AcpTransport {
    return new AcpTransport((msg) => this.log(msg));
  }

  /** Create the JSON-RPC protocol layer on top of a transport. */
  _createProtocol(transport: AcpTransport): AcpProtocol {
    return new AcpProtocol(transport, (msg) => this.log(msg));
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Check if the iFlow CLI is available and return its version.
   * Uses ProcessManager to auto-detect CLI path and Node.js.
   */
  async checkAvailability(): Promise<{ version: string | null; diagnostics: string }> {
    try {
      const startInfo = await this.processManager.resolveStartMode({
        nodePath: getConfig<string | null>('nodePath', null),
        port: getConfig<number>('port', 8090),
      });

      if (!startInfo) {
        return {
          version: null,
          diagnostics: 'iFlow CLI not found. Please install iFlow CLI (npm i -g @iflow-ai/iflow-cli) and ensure it is in your PATH.',
        };
      }

      const version = await this.getCliVersion(startInfo.nodePath, startInfo.iflowScript);
      return {
        version: version ?? 'unknown',
        diagnostics: version
          ? `iFlow CLI v${version} found at ${startInfo.iflowScript}`
          : `iFlow CLI found at ${startInfo.iflowScript} (version unknown)`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { version: null, diagnostics: message };
    }
  }

  /**
   * Run a prompt through the ACP session.
   */
  async run(
    options: RunOptions,
    onChunk: (chunk: StreamChunk) => void,
    onEnd: () => void,
    onError: (error: string) => void,
  ): Promise<string | undefined> {
    try {
      this.running = true;
      this.activeChunkSink = onChunk;
      this.chunkMapper.reset();

      // Settings file I/O (overridable in tests)
      this.updateIFlowCliModel(options.model);
      this.updateIFlowCliApiConfig(undefined);

      // Enforce filesystem path policy for ACP fs/* handlers.
      const cwd = options.cwd ?? process.cwd();
      const allowedDirs = options.fileAllowedDirs && options.fileAllowedDirs.length > 0
        ? options.fileAllowedDirs
        : [cwd];
      this.pathPolicy.setBaseDir(cwd);
      this.pathPolicy.setAllowedDirs(allowedDirs);

      // Establish or reuse ACP connection/session.
      await this.sessionCoordinator.ensureConnected(options);

      const protocol = this.sessionCoordinator.currentProtocol;
      const sessionId = this.sessionCoordinator.currentSessionId;
      if (!protocol || !sessionId) {
        throw new Error('No active ACP protocol/session');
      }
      const debugLogging = getConfig<boolean>('debugLogging', false);

      // ── Inactivity tracking for stuck sub-agents ─────────────────────
      const inactivityTimeoutMs = getConfig<number>('subagentInactivityTimeoutMs', 90000);
      const inactivityState = {
        lastActivityTime: Date.now(),
        lastInProgressTool: null as { name: string; title: string } | null,
        triggered: false,
      };

      const registerNotificationHandler = (): void => {
        protocol.onNotification('session/update', (params: unknown) => {
          inactivityState.lastActivityTime = Date.now();

          const envelope = isObject(params) ? params as AcpNotificationEnvelope : {};
          const update = this.mergeEnvelopeUsage(params, envelope);

          // Track the latest in-progress tool for timeout messages
          if (isObject(update)
            && update.sessionUpdate === 'tool_call_update'
            && update.status === 'in_progress'
            && typeof update.toolName === 'string') {
            inactivityState.lastInProgressTool = {
              name: update.toolName,
              title: typeof update.title === 'string' ? update.title : '',
            };
          }

          if (debugLogging) {
            this.logSessionUpdateDebug(params, envelope, update);
          }
          const chunks = this.chunkMapper.mapUpdateToChunks(update);
          for (const chunk of chunks) {
            onChunk(chunk);
          }
        });
      };

      registerNotificationHandler();

      const inactivityInterval = inactivityTimeoutMs > 0
        ? setInterval(() => {
            if (!this.running || inactivityState.triggered) { return; }
            if (Date.now() - inactivityState.lastActivityTime >= inactivityTimeoutMs) {
              inactivityState.triggered = true;
              this.log(
                `Inactivity detected (${Math.round(inactivityTimeoutMs / 1000)}s). ` +
                `Last tool: ${inactivityState.lastInProgressTool?.name ?? 'none'}. Cancelling...`
              );
              // Cancel with a safety timeout to avoid cancel itself hanging
              Promise.race([
                this.cancel(),
                new Promise<void>(resolve => setTimeout(resolve, 10000)),
              ]).catch(() => {});
            }
          }, 10000)
        : null;

      const builtPrompt = this.chunkMapper.buildPrompt({
        prompt: options.prompt,
        attachedFiles: options.attachedFiles,
        workspaceFiles: options.workspaceFiles,
        ideContext: options.ideContext,
        cwd: options.cwd,
      });

      // ── Execute prompt with inactivity recovery ──────────────────────
      let promptResult: unknown;
      let needsRecovery = false;

      try {
        promptResult = await protocol.sendRequest('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: builtPrompt }],
        });
        if (inactivityState.triggered) {
          needsRecovery = true;
        }
      } catch (promptError) {
        if (inactivityState.triggered) {
          needsRecovery = true;
        } else {
          throw promptError;
        }
      } finally {
        if (inactivityInterval) { clearInterval(inactivityInterval); }
      }

      // ── Inactivity recovery: inform main agent ─────────────────────
      if (needsRecovery && inactivityState.lastInProgressTool) {
        const stuckTool = inactivityState.lastInProgressTool;
        const toolDesc = stuckTool.title || stuckTool.name;
        const timeoutMinutes = Math.round(inactivityTimeoutMs / 60000);

        onChunk({
          chunkType: 'warning',
          message: `Sub-agent "${toolDesc}" appears stuck (no activity for ${timeoutMinutes} min). Notifying main agent...`,
        });

        this.chunkMapper.reset();
        registerNotificationHandler();

        const recoveryPrompt =
          `<system-reminder>The sub-agent "${toolDesc}" (tool: ${stuckTool.name}) ` +
          `was inactive for over ${timeoutMinutes} minutes and has been automatically cancelled. ` +
          `It may not be available or may have encountered an internal error. ` +
          `Please try a different approach or continue without this step.</system-reminder>`;

        promptResult = await protocol.sendRequest('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: recoveryPrompt }],
        });
      }

      const promptUsage = this.extractUsageChunk(promptResult);
      if (promptUsage) {
        onChunk(promptUsage);
      }

      for (const tailChunk of this.chunkMapper.flushToChunks()) {
        onChunk(tailChunk);
      }

      onEnd();
      return this.sessionCoordinator.currentSessionId ?? undefined;
    } catch (err: unknown) {
      const message = normalizeErrorMessage(err, 'Unknown ACP error');
      onError(message);
      return undefined;
    } finally {
      this.running = false;
      this.activeChunkSink = null;
    }
  }

  async cancel(): Promise<void> {
    await this.sessionCoordinator.cancel();
  }

  async dispose(): Promise<void> {
    this.interactionBridge.clearPendingInteractions();
    await this.sessionCoordinator.dispose();
    this.pathPolicy.reset();
  }

  isRunning(): boolean {
    return this.running;
  }

  clearAutoDetectCache(): void {
    this.processManager.clearAutoDetectCache();
  }

  // ── Interactive approval methods ────────────────────────────────────

  async approveToolCall(requestId: number, outcome: string): Promise<void> {
    await this.interactionBridge.approveToolCall(requestId, outcome);
  }

  async rejectToolCall(requestId: number): Promise<void> {
    await this.interactionBridge.rejectToolCall(requestId);
  }

  async answerQuestions(
    requestId: number,
    answers: Record<string, string | string[]>,
  ): Promise<void> {
    await this.interactionBridge.answerQuestions(requestId, answers);
  }

  async approvePlan(requestId: number, approved: boolean): Promise<void> {
    await this.interactionBridge.approvePlan(requestId, approved);
  }

  // ── Settings I/O (overridable for tests) ────────────────────────────

  /** Update the model in iFlow CLI's settings file. */
  updateIFlowCliModel(model: RunOptions['model']): void {
    this.settingsRepository.updateModel(model);
  }

  /** Update the API base URL in iFlow CLI's settings file. */
  updateIFlowCliApiConfig(_baseUrl: string | undefined): void {
    this.settingsRepository.updateBaseUrl(getConfig<string | null>('baseUrl', null));
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private log(msg: string): void {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel('IFlow');
    }
    this.outputChannel.appendLine(`[IFlow] ${msg}`);

    if (getConfig<boolean>('debugLogging', false)) {
      console.log(`[IFlow] ${msg}`);
    }
  }

  private logSessionUpdateDebug(
    params: unknown,
    envelope: AcpNotificationEnvelope,
    update: unknown,
  ): void {
    const sessionId = typeof envelope.sessionId === 'string' ? envelope.sessionId : 'unknown';
    this.log(`[ACP] session/update (sessionId=${sessionId}) ${this.summarizeSessionUpdate(update)}`);
    if (getConfig<boolean>('debugSessionUpdateOnly', false)) {
      return;
    }
    this.log(`[ACP] session/update raw params=${this.stringifyForLog(params)}`);
    if (update !== params) {
      this.log(`[ACP] session/update extracted update=${this.stringifyForLog(update)}`);
    }
  }

  private summarizeSessionUpdate(update: unknown): string {
    if (!isObject(update)) {
      return `non-object update (${typeof update})`;
    }

    const summaryParts: string[] = [];
    const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : 'unknown';
    summaryParts.push(`type=${sessionUpdate}`);

    if (typeof update.status === 'string') {
      summaryParts.push(`status=${update.status}`);
    }
    if (typeof update.toolName === 'string') {
      summaryParts.push(`tool=${update.toolName}`);
    }
    if (typeof update.toolCallId === 'string') {
      summaryParts.push(`toolCallId=${update.toolCallId}`);
    }
    if (typeof update.title === 'string' && update.title.length > 0) {
      summaryParts.push(`title=${this.truncateText(update.title, 120)}`);
    }

    if (isObject(update.args)) {
      const argKeys = Object.keys(update.args);
      summaryParts.push(`argsKeys=${argKeys.length > 0 ? argKeys.join(',') : '(empty)'}`);
      const filePath = this.extractDebugFilePath(update.args);
      if (filePath) {
        summaryParts.push(`path=${this.truncateText(filePath, 200)}`);
      }
    }

    if (Array.isArray(update.locations) && update.locations.length > 0) {
      const first = update.locations[0];
      if (isObject(first) && typeof first.path === 'string') {
        summaryParts.push(`locationPath=${this.truncateText(first.path, 200)}`);
      }
    }

    return summaryParts.join(', ');
  }

  private extractDebugFilePath(args: Record<string, unknown>): string | null {
    const keys = ['file_path', 'path', 'filePath', 'absolute_path', 'file', 'target_file'];
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return null;
  }

  private stringifyForLog(value: unknown): string {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }

    if (serialized.length <= ACP_DEBUG_LOG_MAX_CHARS) {
      return serialized;
    }

    const truncated = serialized.slice(0, ACP_DEBUG_LOG_MAX_CHARS);
    return `${truncated}... [truncated ${serialized.length - ACP_DEBUG_LOG_MAX_CHARS} chars]`;
  }

  private truncateText(value: string, limit: number): string {
    if (value.length <= limit) {
      return value;
    }
    return `${value.slice(0, limit - 3)}...`;
  }

  private mergeEnvelopeUsage(params: unknown, envelope: AcpNotificationEnvelope): unknown {
    const update = envelope.update ?? params;
    if (!isObject(update)) {
      return update;
    }

    const merged: Record<string, unknown> = { ...update };
    for (const key of ['usageMetadata', 'usage', 'tokenUsage'] as const) {
      const value = envelope[key];
      if (value !== undefined && merged[key] === undefined) {
        merged[key] = value;
      }
    }
    return merged;
  }

  private toTokenCount(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return undefined;
    }
    return Math.max(0, Math.round(value));
  }

  private pickUsageField(source: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const parsed = this.toTokenCount(source[key]);
      if (parsed !== undefined) {
        return parsed;
      }
    }
    return undefined;
  }

  private extractUsageChunk(payload: unknown): StreamChunk | null {
    if (!isObject(payload)) {
      return null;
    }

    const sources: Array<Record<string, unknown>> = [payload];
    for (const key of ['usageMetadata', 'usage', 'tokenUsage'] as const) {
      const nested = payload[key];
      if (isObject(nested)) {
        sources.push(nested);
      }
    }

    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let totalTokens: number | undefined;

    for (const source of sources) {
      if (promptTokens === undefined) {
        promptTokens = this.pickUsageField(source, ['promptTokenCount', 'prompt_tokens', 'input_tokens']);
      }
      if (completionTokens === undefined) {
        completionTokens = this.pickUsageField(source, ['candidatesTokenCount', 'completion_tokens', 'output_tokens']);
      }
      if (totalTokens === undefined) {
        totalTokens = this.pickUsageField(source, ['totalTokenCount', 'total_tokens']);
      }
    }

    if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
      return null;
    }

    return {
      chunkType: 'usage',
      promptTokens,
      completionTokens,
      totalTokens,
    };
  }

  private emitChunk(chunk: StreamChunk): void {
    this.activeChunkSink?.(chunk);
  }

  private handleConnectionStateChange(snapshot: ConnectionSnapshot, reason: string, error?: Error): void {
    const session = snapshot.sessionId ?? 'n/a';
    this.log(`ACP connection state: status=${snapshot.status}, reason=${reason}, sessionId=${session}`);

    if (reason !== 'closed') {
      return;
    }

    const warning = error?.message
      ? `ACP connection closed unexpectedly: ${error.message}`
      : 'ACP connection closed unexpectedly.';
    this.emitChunk({ chunkType: 'warning', message: warning });
  }

  /** Get the iFlow CLI version by running: node <script> --version */
  private async getCliVersion(nodePath: string, iflowScript: string): Promise<string | null> {
    const cp = await import('child_process');
    return new Promise((resolve) => {
      cp.execFile(nodePath, [iflowScript, '--version'], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          this.log(`Version check failed: ${err.message}`);
          resolve(null);
          return;
        }
        const match = stdout.trim().match(/[\d]+\.[\d]+\.[\d]+/);
        resolve(match ? match[0] : stdout.trim() || null);
      });
    });
  }
}
