// Process lifecycle management for the iFlow CLI subprocess.

import * as cp from 'child_process';
import * as net from 'net';
import WebSocket = require('ws');
import { findIFlowPathCrossPlatform, resolveIFlowScriptCrossPlatform, deriveNodePathFromIFlow } from './cliDiscovery';
import {
  PROCESS_FORCE_KILL_TIMEOUT_MS,
  PROCESS_WS_MAX_ATTEMPTS,
  PROCESS_WS_RETRY_INTERVAL_MS,
} from './constants/runtime';

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
type WebSocketFactory = (url: string, options?: { handshakeTimeout?: number }) => WebSocket;

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
  private _cachedAutoDetect: { nodePath: string; iflowScript: string } | null | undefined = undefined;
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
    this.createWebSocket = deps.createWebSocket ?? ((url, options) => new WebSocket(url, undefined, options));
    this.checkPortAvailable = deps.isPortAvailable ?? ((port) => this.isPortAvailable(port));
    this.allocateAvailablePort = deps.findAvailablePort ?? (() => this.findAvailablePort());
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
  async autoDetectNodePath(): Promise<{ nodePath: string; iflowScript: string } | null> {
    // undefined = not yet attempted; null = attempted and failed
    if (this._cachedAutoDetect !== undefined) {
      return this._cachedAutoDetect;
    }

    const logFn = this.logInfo;
    this.logInfo('Attempting auto-detection of Node.js path from iflow CLI location');

    const iflowPath = await findIFlowPathCrossPlatform(logFn);
    if (!iflowPath) {
      this.logInfo('Auto-detection: iflow CLI not found in PATH or APPDATA');
      this._cachedAutoDetect = null;
      return null;
    }

    this.logInfo(`Auto-detection: found iflow at ${iflowPath}`);

    const nodePath = await deriveNodePathFromIFlow(iflowPath, logFn);
    if (!nodePath) {
      this.logInfo('Auto-detection: could not derive node path from iflow location');
      this._cachedAutoDetect = null;
      return null;
    }

    const iflowScript = resolveIFlowScriptCrossPlatform(iflowPath, logFn);
    if (!iflowScript) {
      this.logInfo('Auto-detection: failed to resolve iFlow script from CLI wrapper');
      this._cachedAutoDetect = null;
      return null;
    }
    this.logInfo(`Auto-detection successful: node=${nodePath}, script=${iflowScript}`);

    this._cachedAutoDetect = { nodePath, iflowScript };
    return this._cachedAutoDetect;
  }

  /**
   * Determine how to start the iFlow process.
   * Tier 1: User-configured nodePath
   * Tier 2: Auto-detected from iflow CLI location
   * Tier 3: null (caller decides how to proceed)
   */
  async resolveStartMode(config: ProcessManagerConfig): Promise<ManualStartInfo | null> {
    const logFn = this.logInfo;

    // Tier 1: User-configured nodePath
    if (config.nodePath) {
      this.log(`Using user-configured nodePath: ${config.nodePath}`);
      const iflowPath = await findIFlowPathCrossPlatform(logFn);
      if (!iflowPath) {
        throw new Error('iFlow CLI not found. Please install iFlow CLI first.');
      }
      const iflowScript = resolveIFlowScriptCrossPlatform(iflowPath, logFn);
      if (!iflowScript) {
        throw new Error('Failed to resolve iFlow CLI script path from wrapper.');
      }
      return { nodePath: config.nodePath, iflowScript, port: config.port };
    }

    // Tier 2: Auto-detect from iflow CLI location
    const autoDetected = await this.autoDetectNodePath();
    if (autoDetected) {
      this.log(`Using auto-detected node: ${autoDetected.nodePath}`);
      return {
        nodePath: autoDetected.nodePath,
        iflowScript: autoDetected.iflowScript,
        port: config.port,
      };
    }

    // Tier 3: No manual start path available.
    this.log('No manual node path available from user config or auto-detection');
    return null;
  }

  clearAutoDetectCache(): void {
    this._cachedAutoDetect = undefined;
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
      const iflowPath = await findIFlowPathCrossPlatform(logFn);
      if (!iflowPath) {
        throw new Error('iFlow CLI not found in PATH. Please install iFlow CLI first.');
      }
      const resolvedScript = resolveIFlowScriptCrossPlatform(iflowPath, logFn);
      if (!resolvedScript) {
        throw new Error('Failed to resolve iFlow CLI script path from wrapper.');
      }
      iflowScript = resolvedScript;
    }

    let startupPort = port;
    if (autoPortFallback) {
      startupPort = await this.resolveStartupPort(port);
      if (startupPort !== port) {
        this.log(`ACP configured port ${port} is busy; falling back to available port ${startupPort}`);
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
      if (!autoPortFallback || !this.isAddressInUseError(err)) {
        throw err;
      }

      const retryPort = await this.allocateAvailablePort();
      if (retryPort === startupPort) {
        throw err;
      }

      this.log(`ACP port ${startupPort} became unavailable during startup; retrying with port ${retryPort}`);
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
      `Starting iFlow with Node: ${nodePath}, script: ${iflowScript}, port: ${port}, stream=${enableStream}`
    );
    this.log(
      `Command: ${nodePath} ${iflowScript} --experimental-acp --port ${port}${enableStream ? ' --stream' : ''}`
    );

    return new Promise((resolve, reject) => {
      const args = [iflowScript!, '--experimental-acp', '--port', String(port)];
      if (enableStream) {
        args.push('--stream');
      }

      // Buffer to collect output for error reporting
      const stdoutBuffer: string[] = [];
      const stderrBuffer: string[] = [];
      this.managedProcess = this.spawnProcess(nodePath, args, {
        cwd: cwd ?? process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
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
        const parsedPort = this.extractManagedPort(output);
        if (parsedPort !== null && parsedPort !== effectivePort) {
          effectivePort = parsedPort;
          this.log(`Detected managed ACP port from CLI output: ${effectivePort}`);
        }
      };

      const timeout = setTimeout(() => {
        if (!started) {
          settleReject(new Error('iFlow process startup timeout'));
        }
      }, PROCESS_STARTUP_TIMEOUT_MS);

      this.managedProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        ingestOutput(output);
        stdoutBuffer.push(output);
        if (stdoutBuffer.length > STARTUP_LOG_BUFFER_MAX_LINES) {
          stdoutBuffer.shift();
        }
        this.log(`[iFlow stdout] ${output}`);
        // Look for ready signal
        if (this.isReadySignal(output)) {
          if (!started) {
            // Give it a moment to fully initialize
            setTimeout(() => settleResolve(), PROCESS_INIT_DELAY_MS);
          }
        }
      });

      this.managedProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        ingestOutput(output);
        stderrBuffer.push(output);
        if (stderrBuffer.length > STARTUP_LOG_BUFFER_MAX_LINES) {
          stderrBuffer.shift();
        }
        this.log(`[iFlow stderr] ${output}`);
        // Some CLIs output ready messages to stderr
        if (this.isReadySignal(output)) {
          if (!started) {
            setTimeout(() => settleResolve(), PROCESS_INIT_DELAY_MS);
          }
        }
      });

      this.managedProcess.on('error', (err) => {
        this.log(`iFlow process error: ${err.message}`);
        settleReject(new Error(`Failed to start iFlow: ${err.message}`));
      });

      this.managedProcess.on('exit', (code) => {
        this.log(`iFlow process exited with code: ${code}`);
        if (!started && !settled) {
          settleReject(new Error(this.buildStartupFailureMessage(code, stdoutBuffer, stderrBuffer, port)));
        }

        // Process has exited; ensure cached state is reset.
        this.managedPort = null;

        if (!started) {
          // Log collected output for debugging
          if (stdoutBuffer.length > 0) {
            this.log(`[iFlow stdout buffer]\n${stdoutBuffer.join('')}`);
          }
          if (stderrBuffer.length > 0) {
            this.log(`[iFlow stderr buffer]\n${stderrBuffer.join('')}`);
          }
        }
        this.managedProcess = null;
      });

      // If no ready signal, try to connect via WebSocket to confirm server is ready
      let wsTimeout: NodeJS.Timeout | null = null;
      const checkWebSocketReady = async () => {
        for (let attempt = 1; attempt <= PROCESS_WS_MAX_ATTEMPTS; attempt++) {
          if (started || settled || !this.managedProcess || this.managedProcess.killed) {
            return;
          }

          try {
            const wsUrl = `ws://localhost:${effectivePort}/acp`;
            const ws = this.createWebSocket(wsUrl, { handshakeTimeout: PROCESS_WS_HANDSHAKE_TIMEOUT_MS });
            const connectionResult = await new Promise<{ success: boolean; error?: Error }>((resolveWs) => {
              let isResolved = false;

              const cleanup = () => {
                if (wsTimeout) {
                  clearTimeout(wsTimeout);
                  wsTimeout = null;
                }
                // Ensure WebSocket is fully closed
                if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                  ws.terminate();
                }
              };

              ws.on('open', () => {
                if (!isResolved) {
                  isResolved = true;
                  cleanup();
                  resolveWs({ success: true });
                }
              });

              ws.on('error', (err: Error) => {
                if (!isResolved) {
                  isResolved = true;
                  cleanup();
                  resolveWs({ success: false, error: err });
                }
              });

              ws.on('close', () => {
                if (!isResolved) {
                  isResolved = true;
                  cleanup();
                  resolveWs({ success: false, error: new Error('Connection closed') });
                }
              });

              // Timeout fallback
              wsTimeout = setTimeout(() => {
                if (!isResolved) {
                  isResolved = true;
                  cleanup();
                  resolveWs({ success: false, error: new Error('WebSocket timeout') });
                }
              }, PROCESS_READY_FALLBACK_MS);
            });

            if (connectionResult.success) {
              // Connection successful
              if (!started) {
                this.log(`[process ready] WebSocket connection confirmed on port ${effectivePort} after ${attempt} attempt(s)`);
                settleResolve();
              }
              return;
            } else if (this.log && attempt === 1) {
              // Log first failure for debugging
              this.log(`[WebSocket check] Attempt ${attempt} failed: ${connectionResult.error?.message}`);
            }
          } catch (err) {
            // Log unexpected errors
            if (this.log && attempt === 1) {
              this.log(`[WebSocket check] Attempt ${attempt} error: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Connection failed, wait and retry
          if (attempt < PROCESS_WS_MAX_ATTEMPTS && !started) {
            await new Promise(r => setTimeout(r, PROCESS_WS_RETRY_INTERVAL_MS));
          }
        }

        // All attempts failed
        if (!started && !settled) {
          this.log(`[process warning] WebSocket not ready after ${PROCESS_WS_MAX_ATTEMPTS} attempts, proceeding anyway`);
          settleResolve();
        }
      };

      // Start WebSocket readiness check after a short delay
      const initTimeout = setTimeout(() => {
        if (!started && this.managedProcess && !this.managedProcess.killed) {
          checkWebSocketReady();
        }
      }, PROCESS_INIT_DELAY_MS);

      // Cleanup timeout if process exits early
      this.managedProcess.on('exit', () => {
        clearTimeout(initTimeout);
        if (wsTimeout) {
          clearTimeout(wsTimeout);
          wsTimeout = null;
        }
      });
    });
  }

  /**
   * Stop the managed iFlow process.
   * Uses taskkill on Windows (SIGTERM is unreliable there).
   */
  stopManagedProcess(): void {
    if (this.managedProcess) {
      this.log('Stopping managed iFlow process');
      if (process.platform === 'win32') {
        try {
          cp.execSync(
            `taskkill /F /T /PID ${this.managedProcess.pid}`,
            { windowsHide: true, timeout: PROCESS_FORCE_KILL_TIMEOUT_MS, stdio: 'ignore' }
          );
        } catch {
          // Process may have already exited
        }
      } else {
        this.managedProcess.kill('SIGTERM');
      }
      this.managedProcess = null;
      this.managedPort = null;
    }
  }

  private isReadySignal(output: string): boolean {
    const normalized = output.toLowerCase();
    return normalized.includes('listening')
      || normalized.includes('ready')
      || normalized.includes('started websocket service')
      || normalized.includes('server started');
  }

  private isAddressInUseError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return normalized.includes('eaddrinuse')
      || normalized.includes('address already in use')
      || normalized.includes('failed to bind acp port');
  }

  private async resolveStartupPort(configuredPort: number): Promise<number> {
    if (configuredPort <= 0 || configuredPort > 65535) {
      return this.allocateAvailablePort();
    }

    const preferredAvailable = await this.checkPortAvailable(configuredPort);
    if (preferredAvailable) {
      return configuredPort;
    }

    return this.allocateAvailablePort();
  }

  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const server = net.createServer();

      const cleanup = () => {
        server.removeAllListeners();
      };

      server.once('error', () => {
        cleanup();
        resolve(false);
      });

      server.once('listening', () => {
        server.close(() => {
          cleanup();
          resolve(true);
        });
      });

      server.listen(port, '127.0.0.1');
    });
  }

  private async findAvailablePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer();

      const cleanup = () => {
        server.removeAllListeners();
      };

      server.once('error', (err: Error) => {
        cleanup();
        reject(err);
      });

      server.once('listening', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : null;
        server.close(() => {
          cleanup();
          if (typeof port === 'number' && port > 0 && port <= 65535) {
            resolve(port);
          } else {
            reject(new Error('Failed to resolve available ACP port'));
          }
        });
      });

      server.listen(0, '127.0.0.1');
    });
  }

  private extractManagedPort(output: string): number | null {
    const patterns = [
      /\busing port[:\s]+(\d{2,5})\b/i,
      /\bfound available port\s+(\d{2,5})\b/i,
      /\blistening(?:\s+on)?(?:\s+port)?[:\s]+(\d{2,5})\b/i,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(output);
      if (!match) {
        continue;
      }
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
        return parsed;
      }
    }
    return null;
  }

  private buildStartupFailureMessage(
    code: number | null,
    stdoutBuffer: string[],
    stderrBuffer: string[],
    configuredPort: number,
  ): string {
    const combined = `${stdoutBuffer.join('')}\n${stderrBuffer.join('')}`.toLowerCase();
    if (combined.includes('eaddrinuse') || combined.includes('address already in use')) {
      return `iFlow process failed to bind ACP port ${configuredPort} because it is already in use. `
        + 'Please close the conflicting process or change iflow.port.';
    }

    let errorMsg = `iFlow process exited immediately with code ${code}`;
    if (code === 1) {
      errorMsg += '. 可能的原因：--experimental-acp 参数不被支持，请检查 CLI 版本';
    }
    return errorMsg;
  }
}
