// Process lifecycle management for the iFlow CLI subprocess.

import * as cp from "child_process";
import WebSocket = require("ws");
import {
  findIFlowPathCrossPlatform,
  resolveIFlowScriptCrossPlatform,
  deriveNodePathFromIFlow,
} from "./cliDiscovery";
import {
  PROCESS_FORCE_KILL_TIMEOUT_MS,
  PROCESS_WS_MAX_ATTEMPTS,
  PROCESS_WS_RETRY_INTERVAL_MS,
} from "./constants/runtime";
import {
  findAvailablePort,
  isPortAvailable,
  resolveStartupPort,
} from "./process/portDiscovery";
import {
  buildStartupFailureMessage,
  extractManagedPort,
  isAddressInUseError,
  isReadySignal,
} from "./process/startupSignals";
import {
  waitForWebSocketReadiness,
  type WebSocketFactory,
} from "./process/webSocketReadinessProbe";

// ── Process lifecycle constants ──────────────────────────────────────
const PROCESS_STARTUP_TIMEOUT_MS = 30_000;
const PROCESS_READY_FALLBACK_MS = 2_000;
const PROCESS_INIT_DELAY_MS = 500;
const STARTUP_LOG_BUFFER_MAX_LINES = 20;
const PROCESS_WS_HANDSHAKE_TIMEOUT_MS = 1_000;

export interface ManualStartInfo {
  nodePath: string;
  iflowScript: string;
  port: number;
}

interface ProcessManagerConfig {
  nodePath: string | null;
  port: number;
}

type SpawnFn = typeof cp.spawn;
interface ProcessManagerDependencies {
  spawn?: SpawnFn;
  createWebSocket?: WebSocketFactory;
  isPortAvailable?: (port: number) => Promise<boolean>;
  findAvailablePort?: () => Promise<number>;
}

export class ProcessManager {
  private managedProcess: cp.ChildProcess | null = null;
  private managedPort: number | null = null;
  // Auto-detection cache: undefined = not attempted, null = attempted & failed, object = success
  private _cachedAutoDetect:
    | { nodePath: string; iflowScript: string }
    | null
    | undefined = undefined;
  // CLI path cache: undefined = not attempted, null = attempted & failed, string = success
  private _cachedIflowPath: string | null | undefined = undefined;
  private readonly spawnProcess: SpawnFn;
  private readonly createWebSocket: WebSocketFactory;
  private readonly checkPortAvailable: (port: number) => Promise<boolean>;
  private readonly allocateAvailablePort: () => Promise<number>;

  constructor(
    private log: (message: string) => void,
    private logInfo: (message: string) => void,
    deps: ProcessManagerDependencies = {},
  ) {
    this.spawnProcess = deps.spawn ?? cp.spawn;
    this.createWebSocket =
      deps.createWebSocket ??
      ((url, options) => this.createDefaultWebSocket(url, options));
    this.checkPortAvailable = deps.isPortAvailable ?? isPortAvailable;
    this.allocateAvailablePort = deps.findAvailablePort ?? findAvailablePort;
  }

  /** Whether a managed process is currently running. */
  get hasProcess(): boolean {
    return this.managedProcess !== null;
  }

  /** Actual ACP port used by the managed process (if known). */
  get currentPort(): number | null {
    return this.managedPort;
  }

  // ── Auto-detection orchestration ────────────────────────────────

  /**
   * Auto-detect Node.js and iFlow script paths from the iFlow CLI location.
   * Results are cached per instance.
   */
  async autoDetectNodePath(): Promise<{
    nodePath: string;
    iflowScript: string;
  } | null> {
    // undefined = not yet attempted; null = attempted and failed
    if (this._cachedAutoDetect !== undefined) {
      return this._cachedAutoDetect;
    }

    const logFn = this.logInfo;
    this.logInfo(
      "Attempting auto-detection of Node.js path from iflow CLI location",
    );

    const iflowPath = await this.findIFlowPathCached();
    if (!iflowPath) {
      this.logInfo("Auto-detection: iflow CLI not found in PATH or APPDATA");
      this._cachedAutoDetect = null;
      return null;
    }

    this.logInfo(`Auto-detection: found iflow at ${iflowPath}`);

    const iflowScript = resolveIFlowScriptCrossPlatform(iflowPath, logFn);
    if (!iflowScript) {
      this.logInfo(
        "Auto-detection: failed to resolve iFlow script from CLI wrapper",
      );
      this._cachedAutoDetect = null;
      return null;
    }

    const nodePath = await deriveNodePathFromIFlow(
      iflowPath,
      logFn,
      iflowScript,
    );
    if (!nodePath) {
      this.logInfo(
        "Auto-detection: could not derive node path from iflow location",
      );
      this._cachedAutoDetect = null;
      return null;
    }
    this.logInfo(
      `Auto-detection successful: node=${nodePath}, script=${iflowScript}`,
    );

    this._cachedAutoDetect = { nodePath, iflowScript };
    return this._cachedAutoDetect;
  }

  /**
   * Determine how to start the iFlow process.
   * Tier 1: User-configured nodePath
   * Tier 2: Auto-detected from iflow CLI location
   * Tier 3: null (caller decides how to proceed)
   */
  async resolveStartMode(
    config: ProcessManagerConfig,
  ): Promise<ManualStartInfo | null> {
    const logFn = this.logInfo;

    console.log("[IFlow] 开始解析 iflow CLI 启动模式");
    this.log("开始解析 iflow CLI 启动模式");

    // Tier 1: User-configured nodePath (uses cached CLI path lookup)
    if (config.nodePath) {
      console.log(`[IFlow] 使用用户配置的 nodePath: ${config.nodePath}`);
      this.log(`使用用户配置的 nodePath: ${config.nodePath}`);
      const iflowPath = await this.findIFlowPathCached();
      if (!iflowPath) {
        console.log("[IFlow] 未找到 iflow CLI，请先安装");
        this.log("未找到 iflow CLI，请先安装");
        throw new Error("iFlow CLI not found. Please install iFlow CLI first.");
      }
      const iflowScript = resolveIFlowScriptCrossPlatform(iflowPath, logFn);
      if (!iflowScript) {
        console.log("[IFlow] 无法从包装器解析 iFlow CLI 脚本路径");
        this.log("无法从包装器解析 iFlow CLI 脚本路径");
        throw new Error(
          "Failed to resolve iFlow CLI script path from wrapper.",
        );
      }
      console.log(`[IFlow] 使用用户配置的 nodePath: ${config.nodePath}，iflowScript: ${iflowScript}`);
      this.log(`使用用户配置的 nodePath: ${config.nodePath}，iflowScript: ${iflowScript}`);
      return { nodePath: config.nodePath, iflowScript, port: config.port };
    }

    // Tier 2: Check for local iflow-cli in node_modules
    console.log("[IFlow] 检查本地 node_modules 中的 iflow-cli");
    this.log("检查本地 node_modules 中的 iflow-cli");
    const localIFlowPath = this.findLocalIFlowPath();
    if (localIFlowPath) {
      console.log(`[IFlow] 找到本地 iflow-cli: ${localIFlowPath}`);
      this.log(`找到本地 iflow-cli: ${localIFlowPath}`);
      // Try to find node executable in system path
      console.log("[IFlow] 尝试查找系统 node 可执行文件");
      this.log("尝试查找系统 node 可执行文件");
      const nodePath = this.findSystemNodePath();
      if (nodePath) {
        console.log(`[IFlow] 使用系统 node: ${nodePath}`);
        this.log(`使用系统 node: ${nodePath}`);
        console.log(`[IFlow] 返回本地 iflow-cli 启动信息: nodePath=${nodePath}, iflowScript=${localIFlowPath}, port=${config.port}`);
        this.log(`返回本地 iflow-cli 启动信息: nodePath=${nodePath}, iflowScript=${localIFlowPath}, port=${config.port}`);
        return {
          nodePath: nodePath,
          iflowScript: localIFlowPath,
          port: config.port,
        };
      } else {
        console.log("[IFlow] 未找到系统 node 可执行文件");
        this.log("未找到系统 node 可执行文件");
      }
    } else {
      console.log("[IFlow] 未找到本地 iflow-cli");
      this.log("未找到本地 iflow-cli");
    }

    // Tier 3: Auto-detect from iflow CLI location
    console.log("[IFlow] 尝试自动检测 iflow CLI 位置");
    this.log("尝试自动检测 iflow CLI 位置");
    const autoDetected = await this.autoDetectNodePath();
    if (autoDetected) {
      console.log(`[IFlow] 使用自动检测的 node: ${autoDetected.nodePath}`);
      this.log(`使用自动检测的 node: ${autoDetected.nodePath}`);
      console.log(`[IFlow] 返回自动检测的启动信息: nodePath=${autoDetected.nodePath}, iflowScript=${autoDetected.iflowScript}, port=${config.port}`);
      this.log(`返回自动检测的启动信息: nodePath=${autoDetected.nodePath}, iflowScript=${autoDetected.iflowScript}, port=${config.port}`);
      return {
        nodePath: autoDetected.nodePath,
        iflowScript: autoDetected.iflowScript,
        port: config.port,
      };
    } else {
      console.log("[IFlow] 自动检测 iflow CLI 位置失败");
      this.log("自动检测 iflow CLI 位置失败");
    }

    // Tier 4: No manual start path available.
    console.log("[IFlow] 无法从用户配置或自动检测中获取启动路径");
    this.log(
      "无法从用户配置或自动检测中获取启动路径",
    );
    return null;
  }

  private findSystemNodePath(): string | null {
    const isWindows = process.platform === "win32";
    const nodeExe = isWindows ? "node.exe" : "node";
    const path = require('path');

    // Try to find node in PATH
    try {
      const cp = require('child_process');
      const result = isWindows
        ? cp.execSync('where node', { timeout: 5000, encoding: 'utf8' })
        : cp.execSync('which node', { timeout: 5000, encoding: 'utf8' });

      const nodePath = result.trim().split(/\r?\n/)[0];
      if (nodePath) {
        return nodePath;
      }
    } catch (error: unknown) {
      this.logInfo(`Failed to find node in PATH: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Try common node locations
    const commonPaths = isWindows
      ? [
        path.join(process.env.ProgramFiles || '', 'nodejs', 'node.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
        path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'nodejs', 'node.exe')
      ]
      : [
        '/usr/local/bin/node',
        '/opt/homebrew/bin/node',
        '/usr/bin/node',
        '/bin/node'
      ];

    for (const candidate of commonPaths) {
      if (require('fs').existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  clearAutoDetectCache(): void {
    this._cachedAutoDetect = undefined;
    this._cachedIflowPath = undefined;
  }

  // ── Process management ──────────────────────────────────────────────

  /**
   * Start iFlow process manually with a specific Node path.
   * If iflowScript is provided, uses it directly; otherwise discovers it.
   */
  async startManagedProcess(
    nodePath: string,
    port: number,
    iflowScript?: string,
    cwd?: string,
    enableStream = true,
    autoPortFallback = true,
  ): Promise<number> {
    if (!iflowScript) {
      const logFn = this.logInfo;
      const iflowPath = await this.findIFlowPathCached();
      if (!iflowPath) {
        throw new Error(
          "iFlow CLI not found in PATH. Please install iFlow CLI first.",
        );
      }
      const resolvedScript = resolveIFlowScriptCrossPlatform(iflowPath, logFn);
      if (!resolvedScript) {
        throw new Error(
          "Failed to resolve iFlow CLI script path from wrapper.",
        );
      }
      iflowScript = resolvedScript;
    }

    let startupPort = port;
    if (autoPortFallback) {
      startupPort = await resolveStartupPort(port, {
        isPortAvailable: this.checkPortAvailable,
        findAvailablePort: this.allocateAvailablePort,
      });
      if (startupPort !== port) {
        this.log(
          `ACP configured port ${port} is busy; falling back to available port ${startupPort}`,
        );
      }
    }

    try {
      return await this.startManagedProcessOnPort(
        nodePath,
        startupPort,
        iflowScript,
        cwd,
        enableStream,
      );
    } catch (err: unknown) {
      if (!autoPortFallback || !isAddressInUseError(err)) {
        throw err;
      }

      const retryPort = await this.allocateAvailablePort();
      if (retryPort === startupPort) {
        throw err;
      }

      this.log(
        `ACP port ${startupPort} became unavailable during startup; retrying with port ${retryPort}`,
      );
      return this.startManagedProcessOnPort(
        nodePath,
        retryPort,
        iflowScript,
        cwd,
        enableStream,
      );
    }
  }

  private async startManagedProcessOnPort(
    nodePath: string,
    port: number,
    iflowScript: string,
    cwd?: string,
    enableStream = true,
  ): Promise<number> {
    this.log(
      `Starting iFlow with Node: ${nodePath}, script: ${iflowScript}, port: ${port}, stream=${enableStream}`,
    );
    this.log(
      `Command: ${nodePath} ${iflowScript} --experimental-acp --port ${port}${enableStream ? " --stream" : ""}`,
    );

    return new Promise((resolve, reject) => {
      const args = [iflowScript!, "--experimental-acp", "--port", String(port)];
      if (enableStream) {
        args.push("--stream");
      }

      // Buffer to collect output for error reporting
      const stdoutBuffer: string[] = [];
      const stderrBuffer: string[] = [];
      this.managedProcess = this.spawnProcess(nodePath, args, {
        cwd: cwd ?? process.cwd(),
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let settled = false;
      let started = false;
      let effectivePort = port;

      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        started = true;
        clearTimeout(timeout);
        this.managedPort = effectivePort;
        resolve(effectivePort);
      };

      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.managedPort = null;
        reject(error);
      };

      const ingestOutput = (output: string) => {
        const parsedPort = extractManagedPort(output);
        if (parsedPort !== null && parsedPort !== effectivePort) {
          effectivePort = parsedPort;
          this.log(
            `Detected managed ACP port from CLI output: ${effectivePort}`,
          );
        }
      };

      const timeout = setTimeout(() => {
        if (!started) {
          settleReject(new Error("iFlow process startup timeout"));
        }
      }, PROCESS_STARTUP_TIMEOUT_MS);

      this.managedProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        ingestOutput(output);
        stdoutBuffer.push(output);
        if (stdoutBuffer.length > STARTUP_LOG_BUFFER_MAX_LINES) {
          stdoutBuffer.shift();
        }
        this.log(`[iFlow stdout] ${output}`);
        // Look for ready signal
        if (isReadySignal(output)) {
          if (!started) {
            // Give it a moment to fully initialize
            setTimeout(() => settleResolve(), PROCESS_INIT_DELAY_MS);
          }
        }
      });

      this.managedProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();
        ingestOutput(output);
        stderrBuffer.push(output);
        if (stderrBuffer.length > STARTUP_LOG_BUFFER_MAX_LINES) {
          stderrBuffer.shift();
        }
        this.log(`[iFlow stderr] ${output}`);
        // Some CLIs output ready messages to stderr
        if (isReadySignal(output)) {
          if (!started) {
            setTimeout(() => settleResolve(), PROCESS_INIT_DELAY_MS);
          }
        }
      });

      this.managedProcess.on("error", (err) => {
        this.log(`iFlow process error: ${err.message}`);
        settleReject(new Error(`Failed to start iFlow: ${err.message}`));
      });

      // If no ready signal, try to connect via WebSocket to confirm server is ready
      const checkWebSocketReady = async () => {
        const readiness = await waitForWebSocketReadiness({
          createWebSocket: this.createWebSocket,
          getWebSocketUrl: () => `ws://localhost:${effectivePort}/acp`,
          maxAttempts: PROCESS_WS_MAX_ATTEMPTS,
          retryIntervalMs: PROCESS_WS_RETRY_INTERVAL_MS,
          handshakeTimeoutMs: PROCESS_WS_HANDSHAKE_TIMEOUT_MS,
          connectionTimeoutMs: PROCESS_READY_FALLBACK_MS,
          isCancelled: () =>
            started ||
            settled ||
            !this.managedProcess ||
            this.managedProcess.killed,
          onFirstFailure: (message) => {
            this.log(`[WebSocket check] Attempt 1 failed: ${message}`);
          },
        });

        if (readiness.ready) {
          if (!started) {
            this.log(
              `[process ready] WebSocket connection confirmed on port ${effectivePort} ` +
              `after ${readiness.attempts} attempt(s)`,
            );
            settleResolve();
          }
          return;
        }

        if (!started && !settled) {
          this.log(
            `[process warning] WebSocket not ready after ${PROCESS_WS_MAX_ATTEMPTS} attempts, proceeding anyway`,
          );
          settleResolve();
        }
      };

      // Start WebSocket readiness check after a short delay
      const initTimeout = setTimeout(() => {
        if (!started && this.managedProcess && !this.managedProcess.killed) {
          checkWebSocketReady();
        }
      }, PROCESS_INIT_DELAY_MS);

      // Consolidated exit listener: handles rejection, cleanup, and timeout cancellation
      this.managedProcess.on("exit", (code) => {
        clearTimeout(initTimeout);
        this.log(`iFlow process exited with code: ${code}`);
        if (!started && !settled) {
          settleReject(
            new Error(
              buildStartupFailureMessage(
                code,
                stdoutBuffer,
                stderrBuffer,
                port,
              ),
            ),
          );
        }

        // Process has exited; ensure cached state is reset.
        this.managedPort = null;

        if (!started) {
          // Log collected output for debugging
          if (stdoutBuffer.length > 0) {
            this.log(`[iFlow stdout buffer]\n${stdoutBuffer.join("")}`);
          }
          if (stderrBuffer.length > 0) {
            this.log(`[iFlow stderr buffer]\n${stderrBuffer.join("")}`);
          }
        }
        this.managedProcess = null;
      });
    });
  }

  /**
   * Stop the managed iFlow process.
   * Uses taskkill on Windows (SIGTERM is unreliable there).
   */
  stopManagedProcess(): void {
    if (this.managedProcess) {
      this.log("Stopping managed iFlow process");
      if (process.platform === "win32") {
        try {
          cp.execSync(`taskkill /F /T /PID ${this.managedProcess.pid}`, {
            windowsHide: true,
            timeout: PROCESS_FORCE_KILL_TIMEOUT_MS,
            stdio: "ignore",
          });
        } catch {
          // Process may have already exited
        }
      } else {
        this.managedProcess.kill("SIGTERM");
      }
      this.managedProcess = null;
      this.managedPort = null;
    }
  }

  private async findIFlowPathCached(): Promise<string | null> {
    if (this._cachedIflowPath !== undefined) {
      return this._cachedIflowPath;
    }

    // First try: use local iflow-cli from node_modules
    const localIFlowPath = this.findLocalIFlowPath();
    if (localIFlowPath) {
      this.logInfo(`[Local discovery] found iflow CLI in node_modules: ${localIFlowPath}`);
      this._cachedIflowPath = localIFlowPath;
      return this._cachedIflowPath;
    }

    // Fallback: search in PATH
    this._cachedIflowPath = await findIFlowPathCrossPlatform(this.logInfo);
    return this._cachedIflowPath;
  }

  private findLocalIFlowPath(): string | null {
    const path = require('path');
    const fs = require('fs');

    console.log(`[IFlow] __dirname: ${__dirname}`);
    console.log(`[IFlow] 当前工作目录: ${process.cwd()}`);

    // Try to find the extension root directory
    let extensionRoot = __dirname;
    // Move up until we find the package.json file
    for (let i = 0; i < 5; i++) {
      const packageJsonPath = path.join(extensionRoot, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        console.log(`[IFlow] 找到扩展根目录: ${extensionRoot}`);
        break;
      }
      extensionRoot = path.join(extensionRoot, '..');
    }

    // Check for local iflow-cli in src/lib
    const libPath = path.join(extensionRoot, 'scripts', 'lib',  '@iflow-ai', 'iflow-cli', 'bundle','iflow.js');
    console.log(`[IFlow] 正在检查 src/lib 中的 iflow-cli 路径: ${libPath}`);
    this.logInfo(`正在检查 src/lib 中的 iflow-cli 路径: ${libPath}`);
    if (fs.existsSync(libPath)) {
      console.log(`[IFlow] 找到本地 iflow-cli 在 src/lib: ${libPath}`);
      this.logInfo(`找到本地 iflow-cli 在 src/lib: ${libPath}`);
      return libPath;
    } else {
      console.log(`[IFlow] src/lib 中的 iflow-cli 路径不存在: ${libPath}`);
    }

    // Check for local iflow-cli in node_modules
    const localPath = path.join(extensionRoot, 'scripts', 'lib',  '@iflow-ai', 'iflow-cli', 'bundle', 'iflow.js');
    console.log(`[IFlow] 正在检查本地 iflow-cli 路径: ${localPath}`);
    this.logInfo(`正在检查本地 iflow-cli 路径: ${localPath}`);
    if (fs.existsSync(localPath)) {
      console.log(`[IFlow] 找到本地 iflow-cli: ${localPath}`);
      this.logInfo(`找到本地 iflow-cli: ${localPath}`);
      return localPath;
    } else {
      console.log(`[IFlow] 本地 iflow-cli 路径不存在: ${localPath}`);
    }

    // Check for iflow.cmd on Windows
    if (process.platform === 'win32') {
      const cmdPath = path.join(extensionRoot, 'scripts', 'lib', '.bin', 'iflow.cmd');
      console.log(`[IFlow] 正在检查本地 iflow.cmd 路径: ${cmdPath}`);
      this.logInfo(`正在检查本地 iflow.cmd 路径: ${cmdPath}`);
      if (fs.existsSync(cmdPath)) {
        console.log(`[IFlow] 找到本地 iflow.cmd: ${cmdPath}`);
        this.logInfo(`找到本地 iflow.cmd: ${cmdPath}`);
        return cmdPath;
      } else {
        console.log(`[IFlow] 本地 iflow.cmd 路径不存在: ${cmdPath}`);
      }
      const ps1Path = path.join(extensionRoot, 'scripts', 'lib', '.bin', 'iflow.ps1');
      console.log(`[IFlow] 正在检查本地 iflow.ps1 路径: ${ps1Path}`);
      this.logInfo(`正在检查本地 iflow.ps1 路径: ${ps1Path}`);
      if (fs.existsSync(ps1Path)) {
        console.log(`[IFlow] 找到本地 iflow.ps1: ${ps1Path}`);
        this.logInfo(`找到本地 iflow.ps1: ${ps1Path}`);
        return ps1Path;
      } else {
        console.log(`[IFlow] 本地 iflow.ps1 路径不存在: ${ps1Path}`);
      }
    } else {
      // Check for iflow executable on Unix-like systems
      const unixPath = path.join(extensionRoot, 'scripts', 'lib', '.bin', 'iflow');
      console.log(`[IFlow] 正在检查本地 iflow 路径: ${unixPath}`);
      this.logInfo(`正在检查本地 iflow 路径: ${unixPath}`);
      if (fs.existsSync(unixPath)) {
        console.log(`[IFlow] 找到本地 iflow: ${unixPath}`);
        this.logInfo(`找到本地 iflow: ${unixPath}`);
        return unixPath;
      } else {
        console.log(`[IFlow] 本地 iflow 路径不存在: ${unixPath}`);
      }
    }

    // Try specific path based on user's feedback
    const userPath = path.join(extensionRoot, 'scripts', 'lib', '.bin', 'iflow.cmd');
    console.log(`[IFlow] 正在检查用户提供的路径: ${userPath}`);
    if (fs.existsSync(userPath)) {
      console.log(`[IFlow] 找到本地 iflow-cli 在用户提供的路径: ${userPath}`);
      this.logInfo(`找到本地 iflow-cli 在用户提供的路径: ${userPath}`);
      return userPath;
    }

    console.log('[IFlow] 在 node_modules 中未找到本地 iflow-cli');
    this.logInfo('在 node_modules 中未找到本地 iflow-cli');
    return null;
  }

  private createDefaultWebSocket(
    url: string,
    options?: { handshakeTimeout?: number },
  ): ReturnType<WebSocketFactory> {
    return new WebSocket(url, undefined, options);
  }
}
