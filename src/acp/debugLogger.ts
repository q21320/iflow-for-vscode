import * as vscode from 'vscode';

const ACP_DEBUG_LOG_MAX_CHARS = 8000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface AcpNotificationEnvelopeLike {
  sessionId?: unknown;
}

export class AcpDebugLogger {
  private outputChannel: vscode.OutputChannel | null = null;

  constructor(
    private readonly getConfig: <T>(key: string, defaultValue: T) => T,
  ) {}

  log(msg: string): void {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel('IFlow');
    }
    this.outputChannel.appendLine(`[IFlow] ${msg}`);

    if (this.getConfig<boolean>('debugLogging', false)) {
      console.log(`[IFlow] ${msg}`);
    }
  }

  dispose(): void {
    this.outputChannel?.dispose();
    this.outputChannel = null;
  }

  logSessionUpdateDebug(params: unknown, envelope: unknown, update: unknown): void {
    const safeEnvelope = isObject(envelope) ? envelope as AcpNotificationEnvelopeLike : {};
    const sessionId = typeof safeEnvelope.sessionId === 'string' ? safeEnvelope.sessionId : 'unknown';
    this.log(`[ACP] session/update (sessionId=${sessionId}) ${this.summarizeSessionUpdate(update)}`);
    if (this.getConfig<boolean>('debugSessionUpdateOnly', false)) {
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
}
