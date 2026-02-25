// Process lifecycle management for the iFlow CLI subprocess.

import * as cp from 'child_process';
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
}

export class ProcessManager {
  private managedProcess: cp.ChildProcess | null = null;
  // Auto-detection cache: undefined = not attempted, null = attempted & failed, object = success
  private _cachedAutoDetect: { nodePath: string; iflowScript: string } | null | undefined = undefined;
  private readonly spawnProcess: SpawnFn;
  private readonly createWebSocket: WebSocketFactory;

  constructor(
    private log: (message: string) => void,
    private logInfo: (message: string) => void,
    deps: ProcessManagerDependencies = {},
  ) {
    this.spawnProcess = deps.spawn ?? cp.spawn;
    this.createWebSocket = deps.createWebSocket ?? ((url, options) => new WebSocket(url, undefined, options));
  }

  /** Whether a managed process is currently running. */
  get hasProcess(): boolean {
    return this.managedProcess !== null;
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
  ): Promise<void> {
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

      let started = false;
      const timeout = setTimeout(() => {
        if (!started) {
          reject(new Error('iFlow process startup timeout'));
        }
      }, PROCESS_STARTUP_TIMEOUT_MS);

      this.managedProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        stdoutBuffer.push(output);
        if (stdoutBuffer.length > STARTUP_LOG_BUFFER_MAX_LINES) {
          stdoutBuffer.shift();
        }
        this.log(`[iFlow stdout] ${output}`);
        // Look for ready signal
        if (output.includes('listening') || output.includes('ready') || output.includes('port')) {
          if (!started) {
            started = true;
            clearTimeout(timeout);
            // Give it a moment to fully initialize
            setTimeout(() => resolve(), PROCESS_INIT_DELAY_MS);
          }
        }
      });

      this.managedProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        stderrBuffer.push(output);
        if (stderrBuffer.length > STARTUP_LOG_BUFFER_MAX_LINES) {
          stderrBuffer.shift();
        }
        this.log(`[iFlow stderr] ${output}`);
        // Some CLIs output ready messages to stderr
        if (output.includes('listening') || output.includes('ready') || output.includes('Started')) {
          if (!started) {
            started = true;
            clearTimeout(timeout);
            setTimeout(() => resolve(), PROCESS_INIT_DELAY_MS);
          }
        }
      });

      this.managedProcess.on('error', (err) => {
        clearTimeout(timeout);
        this.log(`iFlow process error: ${err.message}`);
        reject(new Error(`Failed to start iFlow: ${err.message}`));
      });

      this.managedProcess.on('exit', (code) => {
        this.log(`iFlow process exited with code: ${code}`);
        if (!started) {
          clearTimeout(timeout);
          // Log collected output for debugging
          if (stdoutBuffer.length > 0) {
            this.log(`[iFlow stdout buffer]\n${stdoutBuffer.join('')}`);
          }
          if (stderrBuffer.length > 0) {
            this.log(`[iFlow stderr buffer]\n${stderrBuffer.join('')}`);
          }
          let errorMsg = `iFlow process exited immediately with code ${code}`;
          if (code === 1) {
            errorMsg += '. 可能的原因：--experimental-acp 参数不被支持，请检查 CLI 版本';
          }
          reject(new Error(errorMsg));
        }
        this.managedProcess = null;
      });

      // If no ready signal, try to connect via WebSocket to confirm server is ready
      let wsTimeout: NodeJS.Timeout | null = null;
      const checkWebSocketReady = async () => {
        const wsUrl = `ws://localhost:${port}/acp`;

        for (let attempt = 1; attempt <= PROCESS_WS_MAX_ATTEMPTS; attempt++) {
          if (started || !this.managedProcess || this.managedProcess.killed) {
            return;
          }

          try {
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
                started = true;
                clearTimeout(timeout);
                this.log(`[process ready] WebSocket connection confirmed on port ${port} after ${attempt} attempt(s)`);
                resolve();
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
        if (!started) {
          this.log(`[process warning] WebSocket not ready after ${PROCESS_WS_MAX_ATTEMPTS} attempts, proceeding anyway`);
          started = true;
          clearTimeout(timeout);
          resolve();
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
    }
  }
}
