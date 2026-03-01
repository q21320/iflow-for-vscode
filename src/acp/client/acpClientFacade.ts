// AcpClient: ACP session lifecycle + public API facade.
// Implements ACP (WebSocket + JSON-RPC 2.0) without SDK dependency.

import * as vscode from "vscode";
import { StreamChunk } from "../../protocol";
import { ChunkMapper } from "../../chunkMapper";
import { AcpTransport } from "../../acpTransport";
import { AcpProtocol } from "../../acpProtocol";
import { ProcessManager } from "../../processManager";
import { InteractionBridge } from "../interactionBridge";
import { classifyAppErrorCode, toAppError } from "../../errorUtils";
import { PathPolicy } from "../pathPolicy";
import { RuntimeConfigApplier } from "../runtimeConfigApplier";
import { SessionCoordinator } from "../sessionCoordinator";
import { SettingsRepository } from "../settingsRepository";
import { AcpDebugLogger } from "../debugLogger";
import { ConnectionSnapshot, RunOptions } from "../types";
import {
  CLI_VERSION_TIMEOUT_MS,
  DEFAULT_INTERACTION_TIMEOUT_MS,
} from "../../constants/runtime";
import { AcpUsageExtractor } from "./acpUsageExtractor";
import { AcpNotificationRouter } from "./acpNotificationRouter";
import { AcpRunExecutor } from "./acpRunExecutor";

/** Read a vscode config value with fallback. */
function getConfig<T>(key: string, defaultValue: T): T {
  return vscode.workspace.getConfiguration("iflow").get<T>(key, defaultValue);
}

export interface AcpClientDeps {
  createTransport?: (log: (msg: string) => void) => AcpTransport;
  createProtocol?: (
    transport: AcpTransport,
    log: (msg: string) => void,
  ) => AcpProtocol;
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
  private readonly debugLogger: AcpDebugLogger;
  private readonly usageExtractor: AcpUsageExtractor;
  private readonly notificationRouter: AcpNotificationRouter;
  private readonly runExecutor: AcpRunExecutor;

  constructor(deps: AcpClientDeps = {}) {
    const transportFactory =
      deps.createTransport ??
      ((log: (msg: string) => void) => new AcpTransport(log));
    const protocolFactory =
      deps.createProtocol ??
      ((transport: AcpTransport, log: (msg: string) => void) =>
        new AcpProtocol(transport, log));

    this.debugLogger = new AcpDebugLogger(getConfig);
    this.chunkMapper = new ChunkMapper((msg) => this.log(msg));
    this.processManager = new ProcessManager(
      (msg) => this.log(msg),
      (msg) => this.log(msg),
    );

    this.settingsRepository = new SettingsRepository((msg) => this.log(msg));
    this.pathPolicy = new PathPolicy();
    this.runtimeConfigApplier = new RuntimeConfigApplier((msg) =>
      this.log(msg),
    );
    this.interactionBridge = new InteractionBridge(
      (chunk) => this.emitChunk(chunk),
      (rawPath) => this.pathPolicy.ensureAllowedPath(rawPath),
      (msg) => this.log(msg),
      {
        interactionTimeoutMs: getConfig<number>(
          "interactionTimeoutMs",
          DEFAULT_INTERACTION_TIMEOUT_MS,
        ),
        enableLegacyQuestionBridge: false,
        // iflow CLI still emits _iflow/plan/exit in some plan-mode flows.
        enableLegacyPlanExitBridge: true,
      },
    );

    this.sessionCoordinator = new SessionCoordinator({
      createTransport: () => transportFactory((msg) => this.log(msg)),
      createProtocol: (transport) =>
        protocolFactory(transport, (msg) => this.log(msg)),
      getProcessManager: () => this.processManager,
      getConfig,
      resolveAuthMethodOrder: (availableMethodIds) =>
        this.resolveAuthMethodOrder(availableMethodIds),
      runtimeConfigApplier: this.runtimeConfigApplier,
      interactionBridge: this.interactionBridge,
      log: (msg) => this.log(msg),
      onConnectionStateChange: (snapshot, reason, error) =>
        this.handleConnectionStateChange(snapshot, reason, error),
    });

    this.usageExtractor = new AcpUsageExtractor();
    this.notificationRouter = new AcpNotificationRouter({
      chunkMapper: this.chunkMapper,
      debugLogger: this.debugLogger,
      usageExtractor: this.usageExtractor,
    });
    this.runExecutor = new AcpRunExecutor({
      chunkMapper: this.chunkMapper,
      pathPolicy: this.pathPolicy,
      sessionCoordinator: this.sessionCoordinator,
      notificationRouter: this.notificationRouter,
      usageExtractor: this.usageExtractor,
      getConfig,
      log: (message) => this.log(message),
      updateIFlowCliModel: (model) => this.updateIFlowCliModel(model),
      updateIFlowCliApiConfig: (baseUrl) =>
        this.updateIFlowCliApiConfig(baseUrl),
      isRunning: () => this.running,
      setRunning: (running) => {
        this.running = running;
      },
      setActiveChunkSink: (sink) => {
        this.activeChunkSink = sink;
      },
      cancel: async () => this.sessionCoordinator.cancel(),
      isMissingSessionError: (error) => this.isMissingSessionError(error),
      recoverMissingSession: async (options) =>
        this.recoverMissingSession(options),
    });
  }

  // Backward-compat test hooks for legacy unit tests.
  get pendingPermissions(): Map<number, unknown> {
    return this.interactionBridge.getPendingInteractionsForTests() as unknown as Map<
      number,
      unknown
    >;
  }

  set pendingPermissions(map: Map<number, unknown>) {
    this.interactionBridge.replacePendingInteractionsForTests(
      map as unknown as ReturnType<
        InteractionBridge["getPendingInteractionsForTests"]
      >,
    );
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Check if the iFlow CLI is available and return its version.
   * Uses ProcessManager to auto-detect CLI path and Node.js.
   */
  async checkAvailability(): Promise<{
    version: string | null;
    diagnostics: string;
  }> {
    try {
      const startInfo = await this.processManager.resolveStartMode({
        nodePath: getConfig<string | null>("nodePath", null),
        port: getConfig<number>("port", 8090),
      });

      if (!startInfo) {
        return {
          version: null,
          diagnostics:
            "iFlow CLI not found. Please install iFlow CLI (npm i -g @iflow-ai/iflow-cli) and ensure it is in your PATH.",
        };
      }

      const version = await this.getCliVersion(
        startInfo.nodePath,
        startInfo.iflowScript,
      );
      return {
        version: version ?? "unknown",
        diagnostics: version
          ? `iFlow CLI v${version} found at ${startInfo.iflowScript}`
          : `iFlow CLI found at ${startInfo.iflowScript} (version unknown)`,
      };
    } catch (err: unknown) {
      const appError = toAppError(err);
      return { version: null, diagnostics: appError.message };
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
    return this.runExecutor.run(options, {
      onChunk,
      onEnd,
      onError,
    });
  }

  async cancel(): Promise<void> {
    await this.runExecutor.cancel();
  }

  async resetConnection(): Promise<void> {
    this.interactionBridge.clearPendingInteractions();
    await this.sessionCoordinator.reset();
    this.pathPolicy.reset();
  }

  async dispose(): Promise<void> {
    this.interactionBridge.clearPendingInteractions();
    await this.sessionCoordinator.dispose();
    this.pathPolicy.reset();
    this.debugLogger.dispose();
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
  updateIFlowCliModel(model: RunOptions["model"]): void {
    this.settingsRepository.updateModel(model);
  }

  /** Update the API base URL in iFlow CLI's settings file. */
  updateIFlowCliApiConfig(_baseUrl: string | undefined): void {
    this.settingsRepository.updateBaseUrl(
      getConfig<string | null>("baseUrl", null),
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private log(msg: string): void {
    this.debugLogger.log(msg);
  }

  private emitChunk(chunk: StreamChunk): void {
    this.activeChunkSink?.(chunk);
  }

  private resolveAuthMethodOrder(availableMethodIds: string[]): string[] {
    const selectedAuthType = this.settingsRepository.getSelectedAuthType();

    // Only allow selectedAuthType to take priority over the built-in defaults
    // when it is a distinct custom auth method (not the built-in "iflow" API-key
    // auth, which must never be preferred over "oauth-iflow"). When the user has
    // selectedAuthType="iflow" in their settings file the extension would
    // otherwise authenticate with the legacy API-key path first, causing the
    // CLI to return an empty response because the OAuth session is never
    // established.
    const builtInAuthTypes = new Set([
      "oauth-iflow",
      "iflow",
      "openai-compatible",
    ]);
    const effectiveSelectedType =
      typeof selectedAuthType === "string" &&
      selectedAuthType.length > 0 &&
      !builtInAuthTypes.has(selectedAuthType)
        ? selectedAuthType
        : null;

    const requested = [
      effectiveSelectedType,
      "oauth-iflow",
      "iflow",
      "openai-compatible",
    ].filter((id): id is string => typeof id === "string" && id.length > 0);

    if (availableMethodIds.length === 0) {
      return requested;
    }

    const availableSet = new Set(availableMethodIds);
    return requested.filter(
      (id, index) => requested.indexOf(id) === index && availableSet.has(id),
    );
  }

  private isMissingSessionError(error: unknown): boolean {
    return classifyAppErrorCode(error) === "MISSING_SESSION";
  }

  private async recoverMissingSession(
    options: RunOptions,
  ): Promise<{ protocol: AcpProtocol; sessionId: string }> {
    await this.sessionCoordinator.ensureConnected({
      ...options,
      sessionId: undefined,
    });
    const protocol = this.sessionCoordinator.currentProtocol;
    const sessionId = this.sessionCoordinator.currentSessionId;
    if (!protocol || !sessionId) {
      throw new Error("Failed to recover ACP session after session-not-found");
    }
    return { protocol, sessionId };
  }

  private handleConnectionStateChange(
    snapshot: ConnectionSnapshot,
    reason: string,
    error?: Error,
  ): void {
    const session = snapshot.sessionId ?? "n/a";
    this.log(
      `ACP connection state: status=${snapshot.status}, reason=${reason}, sessionId=${session}`,
    );

    if (reason !== "closed") {
      return;
    }

    const warning = error?.message
      ? `ACP connection closed unexpectedly: ${error.message}`
      : "ACP connection closed unexpectedly.";
    this.emitChunk({ chunkType: "warning", message: warning });
  }

  /** Get the iFlow CLI version by running: node <script> --version */
  private async getCliVersion(
    nodePath: string,
    iflowScript: string,
  ): Promise<string | null> {
    const cp = await import("child_process");
    return new Promise((resolve) => {
      cp.execFile(
        nodePath,
        [iflowScript, "--version"],
        { timeout: CLI_VERSION_TIMEOUT_MS },
        (err, stdout) => {
          if (err) {
            this.log(`Version check failed: ${err.message}`);
            resolve(null);
            return;
          }
          const match = stdout.trim().match(/[\d]+\.[\d]+\.[\d]+/);
          resolve(match ? match[0] : stdout.trim() || null);
        },
      );
    });
  }
}
