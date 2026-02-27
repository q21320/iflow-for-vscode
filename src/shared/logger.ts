export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  component: string;
  sessionId?: string;
  conversationId?: string;
}

export interface AppLogger {
  child(context: Partial<LogContext>): AppLogger;
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, error?: unknown, extra?: Record<string, unknown>): void;
}

export interface OutputChannelLike {
  appendLine(value: string): void;
  dispose(): void;
}

export interface OutputChannelLoggerOptions {
  createChannel: () => OutputChannelLike;
  getDebugLoggingEnabled?: () => boolean;
  now?: () => Date;
}

interface ChannelRef {
  channel: OutputChannelLike | null;
}

export class OutputChannelLogger implements AppLogger {
  private readonly now: () => Date;

  constructor(
    private readonly context: LogContext,
    private readonly options: OutputChannelLoggerOptions,
    private readonly channelRef: ChannelRef = { channel: null },
  ) {
    this.now = options.now ?? (() => new Date());
  }

  child(context: Partial<LogContext>): AppLogger {
    return new OutputChannelLogger(
      {
        component: context.component ?? this.context.component,
        sessionId: context.sessionId ?? this.context.sessionId,
        conversationId: context.conversationId ?? this.context.conversationId,
      },
      this.options,
      this.channelRef,
    );
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    if (!this.options.getDebugLoggingEnabled?.()) {
      return;
    }
    this.write('debug', message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.write('info', message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.write('warn', message, extra);
  }

  error(message: string, error?: unknown, extra?: Record<string, unknown>): void {
    const payload: Record<string, unknown> = { ...(extra ?? {}) };
    if (error !== undefined) {
      payload.error = this.serializeError(error);
    }
    this.write('error', message, Object.keys(payload).length > 0 ? payload : undefined);
  }

  dispose(): void {
    this.channelRef.channel?.dispose();
    this.channelRef.channel = null;
  }

  private write(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    const channel = this.getChannel();
    const timestamp = this.now().toISOString();
    const component = this.context.component || 'unknown';
    const suffix = extra && Object.keys(extra).length > 0
      ? ` ${this.safeStringify(extra)}`
      : '';
    channel.appendLine(`[${timestamp}] [${level.toUpperCase()}] [${component}] ${message}${suffix}`);
  }

  private getChannel(): OutputChannelLike {
    if (!this.channelRef.channel) {
      this.channelRef.channel = this.options.createChannel();
    }
    return this.channelRef.channel;
  }

  private safeStringify(value: Record<string, unknown>): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private serializeError(error: unknown): Record<string, unknown> | string {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    try {
      return JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
    } catch {
      return String(error);
    }
  }
}
