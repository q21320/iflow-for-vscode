// AcpClient: ACP session lifecycle + public API.
// Replaces iflowClient.ts by implementing ACP (WebSocket + JSON-RPC 2.0)
// directly — no SDK dependency, no monkey-patches.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StreamChunk, ConversationMode, ModelType, AttachedFile, IDEContext } from './protocol';
import { ChunkMapper } from './chunkMapper';
import { AcpTransport, AcpTransportOptions } from './acpTransport';
import { AcpProtocol } from './acpProtocol';
import { ProcessManager } from './processManager';

interface RunOptions {
  prompt: string;
  attachedFiles: AttachedFile[];
  mode: ConversationMode;
  think: boolean;
  model: ModelType;
  workspaceFiles?: string[];
  sessionId?: string;
  ideContext?: IDEContext;
  cwd?: string;
  fileAllowedDirs?: string[];
}

interface PermissionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

interface PendingPermission {
  kind: 'permission';
  resolve: (value: unknown) => void;
  options: PermissionOption[];
}

interface PendingQuestion {
  kind: 'question';
  resolve: (value: unknown) => void;
}

interface PendingPlan {
  kind: 'plan';
  resolve: (value: unknown) => void;
}

type PendingInteraction = PendingPermission | PendingQuestion | PendingPlan;

interface AcpNotificationEnvelope {
  sessionId?: string;
  update?: unknown;
}

interface SessionUpdateBase {
  sessionUpdate?: string;
}

interface SessionUpdateContent {
  type?: string;
  text?: string;
}

interface ToolCallParams {
  toolCall?: {
    title?: string;
    toolName?: string;
    kind?: string;
  };
  options?: PermissionOption[];
}

interface QuestionOption {
  label?: string;
  description?: string;
}

interface QuestionPrompt {
  question?: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

interface QuestionParams {
  questions?: QuestionPrompt[];
}

interface PlanParams {
  plan?: string;
}

/**
 * Plan mode workflow instructions appended to the system prompt when the
 * session mode is 'plan'. The ACP path does not inject these automatically.
 */
const PLAN_MODE_INSTRUCTIONS = `
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Enhanced Planning Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions.

1. Focus on understanding the user's request and the code associated with their request
2. Use read-only tools (read_file, glob, list_directory, search_file_content) to explore the codebase
3. If you need clarification, use the ask_user_question tool to ask structured questions with predefined options

### Phase 2: Planning
Goal: Come up with an approach to solve the problem identified in phase 1.
- Provide any background context that may help with the task
- Create a detailed plan using todo_write

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use the ask_user_question tool to ask the user any remaining questions

### Phase 4: Final Plan
Once you have all the information you need, provide your synthesized recommendation including:
- Recommended approach with rationale
- Key insights from different perspectives

### Phase 5: Call exit_plan_mode
CRITICAL: At the very end of your turn, once you are happy with your final plan, you MUST call the exit_plan_mode tool. This is mandatory.
Your turn should ONLY end by calling exit_plan_mode. Do NOT end your turn with just text - always call exit_plan_mode as the final action.
`.trim();

const MODEL_ID_MAP: Partial<Record<ModelType, string>> = {
  'GLM-4.7': 'glm-4.7',
  'GLM-5': 'glm-5',
  'DeepSeek-V3.2': 'deepseek-v3.2-chat',
  'iFlow-ROME-30BA3B(Preview)': 'iFlow-ROME-30BA3B',
  'Qwen3-Coder-Plus': 'qwen3-coder-plus',
  'Kimi-K2-Thinking': 'kimi-k2-thinking',
  'MiniMax-M2.5': 'minimax-m2.5',
  'MiniMax-M2.1': 'minimax-m2.1',
  'Kimi-K2-0905': 'kimi-k2-0905',
  'Kimi-K2.5': 'kimi-k2.5',
};

/** Read a vscode config value with fallback. */
function getConfig<T>(key: string, defaultValue: T): T {
  return vscode.workspace.getConfiguration('iflow').get<T>(key, defaultValue);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class AcpClient {
  private transport: AcpTransport | null = null;
  private protocol: AcpProtocol | null = null;
  private isConnected = false;
  private sessionId: string | null = null;
  private running = false;
  private connectedMode: ConversationMode | null = null;
  private connectedCwd: string | null = null;
  private chunkMapper: ChunkMapper;
  private processManager: ProcessManager;
  private outputChannel: vscode.OutputChannel | null = null;

  /** Allowed directory roots for fs/read_text_file and fs/write_text_file. */
  private allowedDirs: string[] = [];

  /** Current stream chunk callback (set during run()). */
  private activeChunkSink: ((chunk: StreamChunk) => void) | null = null;

  /** Pending interactive requests from server methods keyed by JSON-RPC id. */
  private pendingPermissions = new Map<number, PendingInteraction>();

  constructor() {
    this.chunkMapper = new ChunkMapper((msg) => this.log(msg));
    this.processManager = new ProcessManager(
      (msg) => this.log(msg),
      (msg) => this.log(msg),
    );
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

      // Try to get version by running: node <script> --version
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
   *
   * ACP 0.5.13 semantics:
   * - session/prompt takes {sessionId, prompt:[...]} and resolves on stopReason
   * - streaming deltas come through session/update notifications
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

      // Establish or reuse connection
      await this.ensureConnected(options);

      if (!this.sessionId) {
        throw new Error('No active ACP session ID');
      }

      // Register session/update notification handler
      this.protocol!.onNotification('session/update', (params: unknown) => {
        const envelope = isObject(params) ? params as AcpNotificationEnvelope : {};
        const update = envelope.update ?? params;
        const chunks = this.chunkMapper.mapUpdateToChunks(update);
        for (const chunk of chunks) {
          onChunk(chunk);
        }
      });

      // Build prompt with workspace context
      const builtPrompt = this.chunkMapper.buildPrompt({
        prompt: options.prompt,
        attachedFiles: options.attachedFiles,
        workspaceFiles: options.workspaceFiles,
        ideContext: options.ideContext,
        cwd: options.cwd,
      });

      // Send the prompt. This resolves when the turn ends.
      await this.protocol!.sendRequest('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: builtPrompt }],
      });

      // Flush any trailing parser/native-thinking state.
      for (const tailChunk of this.chunkMapper.flushToChunks()) {
        onChunk(tailChunk);
      }

      onEnd();
      return this.sessionId ?? undefined;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      onError(message);
      return undefined;
    } finally {
      this.running = false;
      this.activeChunkSink = null;
    }
  }

  async cancel(): Promise<void> {
    if (this.protocol && this.isConnected && this.sessionId) {
      await this.protocol.sendRequest('session/cancel', { sessionId: this.sessionId });
    }
  }

  async dispose(): Promise<void> {
    this.pendingPermissions.clear();

    if (this.protocol) {
      this.protocol.dispose();
      this.protocol = null;
    }

    if (this.transport) {
      await this.transport.disconnect();
      this.transport = null;
    }

    this.processManager.stopManagedProcess();

    this.isConnected = false;
    this.sessionId = null;
    this.connectedMode = null;
    this.connectedCwd = null;
    this.allowedDirs = [];
  }

  isRunning(): boolean {
    return this.running;
  }

  clearAutoDetectCache(): void {
    this.processManager.clearAutoDetectCache();
  }

  // ── Interactive approval methods ────────────────────────────────────

  async approveToolCall(requestId: number, outcome: string): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.kind !== 'permission') {
      return;
    }

    this.pendingPermissions.delete(requestId);

    const optionId = this.pickPermissionOptionId(
      pending.options,
      outcome === 'alwaysAllow' ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always'],
    );

    if (optionId) {
      pending.resolve({ outcome: { outcome: 'selected', optionId } });
      return;
    }

    // Fallback: no compatible option exposed by server.
    pending.resolve({ outcome: { outcome: 'cancelled' } });
  }

  async rejectToolCall(requestId: number): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.kind !== 'permission') {
      return;
    }

    this.pendingPermissions.delete(requestId);
    pending.resolve({ outcome: { outcome: 'cancelled' } });
  }

  async answerQuestions(
    requestId: number,
    answers: Record<string, string | string[]>,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.kind !== 'question') {
      return;
    }

    this.pendingPermissions.delete(requestId);
    pending.resolve({ answers });
  }

  async approvePlan(requestId: number, approved: boolean): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.kind !== 'plan') {
      return;
    }

    this.pendingPermissions.delete(requestId);
    pending.resolve({ approved });
  }

  // ── Settings I/O (overridable for tests) ────────────────────────────

  /** Update the model in iFlow CLI's settings file. */
  updateIFlowCliModel(model: ModelType): void {
    try {
      const { settings, path: settingsPath } = this.readSettings();
      if (settings.modelName !== model) {
        this.writeSettings({ ...settings, modelName: model }, settingsPath);
      }
    } catch (err: unknown) {
      this.log(`Failed to update model: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Update the API base URL in iFlow CLI's settings file. */
  updateIFlowCliApiConfig(_baseUrl: string | undefined): void {
    try {
      const configBaseUrl = getConfig<string | null>('baseUrl', null);
      if (!configBaseUrl) {
        return;
      }

      const { settings, path: settingsPath } = this.readSettings();
      if (settings.baseUrl !== configBaseUrl) {
        this.writeSettings({ ...settings, baseUrl: configBaseUrl }, settingsPath);
      }
    } catch (err: unknown) {
      this.log(`Failed to update API config: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  private emitChunk(chunk: StreamChunk): void {
    this.activeChunkSink?.(chunk);
  }

  private pickPermissionOptionId(options: PermissionOption[], preferredKinds: string[]): string | null {
    for (const kind of preferredKinds) {
      const match = options.find((opt) => opt.kind === kind && typeof opt.optionId === 'string');
      if (match) {
        return match.optionId;
      }
    }

    const fallback = options.find((opt) => typeof opt.optionId === 'string' && opt.kind !== 'reject_once' && opt.kind !== 'reject_always');
    return fallback?.optionId ?? null;
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

  /** Read iFlow settings from ~/.iflow/settings.json */
  private readSettings(): { settings: Record<string, unknown>; path: string } {
    const settingsPath = this.getIFlowSettingsPath();
    const dir = path.dirname(settingsPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(settingsPath)) {
      return { settings: {}, path: settingsPath };
    }

    try {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      return { settings: JSON.parse(content), path: settingsPath };
    } catch {
      this.log(`Failed to parse settings at ${settingsPath}, returning empty`);
      return { settings: {}, path: settingsPath };
    }
  }

  /** Write settings to a JSON file. Returns true on success. */
  private writeSettings(settings: Record<string, unknown>, settingsPath: string): boolean {
    try {
      const dir = path.dirname(settingsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      return true;
    } catch (err: unknown) {
      this.log(`Failed to write settings: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Get the path to iFlow's settings file. */
  private getIFlowSettingsPath(): string {
    return path.join(os.homedir(), '.iflow', 'settings.json');
  }

  private toComparablePath(inputPath: string): string {
    return process.platform === 'win32' ? inputPath.toLowerCase() : inputPath;
  }

  private isSubPath(parent: string, child: string): boolean {
    const rel = path.relative(this.toComparablePath(parent), this.toComparablePath(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  private findNearestExistingPath(inputPath: string): string {
    let current = path.resolve(inputPath);

    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Path does not exist: ${inputPath}`);
      }
      current = parent;
    }

    return current;
  }

  private canonicalizePath(inputPath: string): string {
    const absolute = path.resolve(inputPath);

    if (fs.existsSync(absolute)) {
      return fs.realpathSync(absolute);
    }

    const nearestExisting = this.findNearestExistingPath(absolute);
    const realNearest = fs.realpathSync(nearestExisting);
    const suffix = path.relative(nearestExisting, absolute);
    return path.resolve(realNearest, suffix);
  }

  private setAllowedDirs(options: RunOptions): void {
    const candidates = options.fileAllowedDirs && options.fileAllowedDirs.length > 0
      ? options.fileAllowedDirs
      : [options.cwd ?? process.cwd()];

    const normalized = new Set<string>();
    for (const dir of candidates) {
      try {
        normalized.add(this.canonicalizePath(dir));
      } catch {
        normalized.add(path.resolve(dir));
      }
    }

    this.allowedDirs = [...normalized];
  }

  private ensureAllowedPath(rawPath: string): string {
    const baseDir = this.connectedCwd ?? process.cwd();
    const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
    const canonical = this.canonicalizePath(absolute);

    if (this.allowedDirs.length === 0) {
      return canonical;
    }

    const allowed = this.allowedDirs.some((dir) => this.isSubPath(dir, canonical));
    if (!allowed) {
      throw new Error(`Access denied: ${rawPath} is outside allowed directories`);
    }

    return canonical;
  }

  private buildSessionSettings(options: RunOptions): Record<string, unknown> {
    const sessionSettings: Record<string, unknown> = {
      permission_mode: options.mode,
    };

    if (options.mode === 'plan') {
      sessionSettings.append_system_prompt = PLAN_MODE_INSTRUCTIONS;
    }

    if (options.fileAllowedDirs && options.fileAllowedDirs.length > 0) {
      sessionSettings.add_dirs = options.fileAllowedDirs;
    }

    return sessionSettings;
  }

  private modelIdCandidates(model: ModelType): string[] {
    const mapped = MODEL_ID_MAP[model];
    if (mapped && mapped !== model) {
      return [mapped, model];
    }
    return [model];
  }

  private async applySessionRuntimeSettings(options: RunOptions): Promise<void> {
    if (!this.protocol || !this.sessionId) {
      throw new Error('No active protocol/session for runtime settings');
    }

    await this.protocol.sendRequest('session/set_mode', {
      sessionId: this.sessionId,
      modeId: options.mode,
    });

    const modelCandidates = this.modelIdCandidates(options.model);
    let modelUpdated = false;

    for (const modelId of modelCandidates) {
      try {
        await this.protocol.sendRequest('session/set_model', {
          sessionId: this.sessionId,
          modelId,
        });
        modelUpdated = true;
        break;
      } catch (err) {
        this.log(`session/set_model failed for '${modelId}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!modelUpdated) {
      this.log(`session/set_model could not apply model '${options.model}', falling back to CLI settings file`);
    }

    const thinkPayload: Record<string, unknown> = {
      sessionId: this.sessionId,
      thinkEnabled: options.think,
    };
    if (options.think) {
      thinkPayload.thinkConfig = 'think';
    }

    await this.protocol.sendRequest('session/set_think', thinkPayload);
  }

  /**
   * Ensure a WebSocket + JSON-RPC connection is established and
   * a session is created or loaded.
   */
  private async ensureConnected(options: RunOptions): Promise<void> {
    this.setAllowedDirs(options);

    // Reuse existing connection if cwd hasn't changed.
    const needReconnect = !this.isConnected
      || !this.protocol
      || this.connectedCwd !== (options.cwd ?? null);

    if (!needReconnect) {
      // Load existing session if sessionId changed.
      if (options.sessionId && options.sessionId !== this.sessionId) {
        await this.protocol!.sendRequest('session/load', {
          sessionId: options.sessionId,
          cwd: options.cwd ?? process.cwd(),
          mcpServers: [],
          settings: this.buildSessionSettings(options),
        });
        this.sessionId = options.sessionId;
      }

      await this.applySessionRuntimeSettings(options);
      this.connectedMode = options.mode;
      return;
    }

    // Disconnect any existing connection.
    if (this.isConnected) {
      await this.dispose();
    }

    const port = getConfig<number>('port', 8090);
    const timeout = getConfig<number>('timeout', 60000);

    // Start CLI process if not already running.
    if (!this.processManager.hasProcess) {
      const startInfo = await this.processManager.resolveStartMode({
        nodePath: getConfig<string | null>('nodePath', null),
        port,
      });

      if (startInfo) {
        await this.processManager.startManagedProcess(
          startInfo.nodePath,
          startInfo.port,
          startInfo.iflowScript,
          options.cwd,
        );
      } else {
        throw new Error(
          'iFlow CLI not found. Please install it (npm i -g @iflow-ai/iflow-cli) or set iflow.nodePath in settings.'
        );
      }
    }

    // Create transport and connect.
    const transport = this._createTransport();
    this.transport = transport;

    const connectOptions: AcpTransportOptions = {
      url: `ws://localhost:${port}/acp`,
      timeout,
    };
    await transport.connect(connectOptions);

    // Handle unexpected connection close.
    transport.onClose = (error) => {
      this.log(`Connection closed: ${error?.message ?? 'unknown reason'}`);
      this.isConnected = false;
      this.sessionId = null;
    };

    // Create protocol layer.
    const protocol = this._createProtocol(transport);
    this.protocol = protocol;

    // Register server method handlers before starting the receive loop.
    this.registerServerHandlers(protocol);

    // Start the async receive loop.
    protocol.startReceiveLoop();

    // ACP handshake: initialize -> authenticate -> session/new|session/load.
    const initResult = await protocol.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    }) as { isAuthenticated?: boolean };

    // Authenticate if not already authenticated.
    if (!initResult.isAuthenticated) {
      await protocol.sendRequest('authenticate', {
        methodId: 'iflow',
      });
    }

    // Create or load session.
    const cwd = options.cwd ?? process.cwd();
    const sessionSettings = this.buildSessionSettings(options);

    if (options.sessionId) {
      await protocol.sendRequest('session/load', {
        sessionId: options.sessionId,
        cwd,
        mcpServers: [],
        settings: sessionSettings,
      });
      this.sessionId = options.sessionId;
    } else {
      const sessionResult = await protocol.sendRequest('session/new', {
        cwd,
        mcpServers: [],
        settings: sessionSettings,
      }) as { sessionId?: string };

      if (!sessionResult.sessionId) {
        throw new Error('session/new did not return sessionId');
      }
      this.sessionId = sessionResult.sessionId;
    }

    this.isConnected = true;
    this.connectedMode = options.mode;
    this.connectedCwd = options.cwd ?? null;

    await this.applySessionRuntimeSettings(options);
  }

  /**
   * Register handlers for server-initiated methods.
   * These handle interactive approval flows (permission, questions, plan)
   * and file I/O requests from the CLI.
   */
  private registerServerHandlers(protocol: AcpProtocol): void {
    // Tool permission request.
    protocol.onServerMethod(
      'session/request_permission',
      async (id: number, params: unknown) => {
        const toolParams = (isObject(params) ? params : {}) as ToolCallParams;
        const toolName = toolParams.toolCall?.toolName
          ?? toolParams.toolCall?.title
          ?? 'unknown';
        this.emitChunk({
          chunkType: 'tool_confirmation',
          requestId: id,
          toolName,
          description: toolParams.toolCall?.title ?? toolName,
          confirmationType: toolParams.toolCall?.kind ?? 'other',
        });

        return new Promise((resolve) => {
          this.pendingPermissions.set(id, {
            kind: 'permission',
            resolve,
            options: toolParams.options ?? [],
          });
        });
      },
    );

    // User questions.
    protocol.onServerMethod(
      '_iflow/user/questions',
      async (id: number, params: unknown) => {
        const questionParams = (isObject(params) ? params : {}) as QuestionParams;
        const mappedQuestions = (questionParams.questions ?? []).map((q) => ({
          question: q.question ?? '',
          header: q.header ?? 'Question',
          options: (q.options ?? []).map((opt) => ({
            label: opt.label ?? '',
            description: opt.description ?? '',
          })),
          multiSelect: q.multiSelect ?? false,
        }));

        this.emitChunk({
          chunkType: 'user_question',
          requestId: id,
          questions: mappedQuestions,
        });

        return new Promise((resolve) => {
          this.pendingPermissions.set(id, { kind: 'question', resolve });
        });
      },
    );

    // Plan exit (approval).
    protocol.onServerMethod(
      '_iflow/plan/exit',
      async (id: number, params: unknown) => {
        const planParams = (isObject(params) ? params : {}) as PlanParams;

        this.emitChunk({
          chunkType: 'plan_approval',
          requestId: id,
          plan: planParams.plan ?? '',
        });

        return new Promise((resolve) => {
          this.pendingPermissions.set(id, { kind: 'plan', resolve });
        });
      },
    );

    // File read.
    protocol.onServerMethod(
      'fs/read_text_file',
      async (_id: number, params: unknown) => {
        try {
          if (!isObject(params) || typeof params.path !== 'string') {
            return { error: 'Invalid read_text_file params' };
          }

          const safePath = this.ensureAllowedPath(params.path);
          const content = fs.readFileSync(safePath, 'utf-8');
          return { content };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: message };
        }
      },
    );

    // File write.
    protocol.onServerMethod(
      'fs/write_text_file',
      async (_id: number, params: unknown) => {
        try {
          if (!isObject(params) || typeof params.path !== 'string' || typeof params.content !== 'string') {
            return { error: 'Invalid write_text_file params' };
          }

          const safePath = this.ensureAllowedPath(params.path);
          fs.mkdirSync(path.dirname(safePath), { recursive: true });
          fs.writeFileSync(safePath, params.content, 'utf-8');
          return null;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: message };
        }
      },
    );
  }
}
