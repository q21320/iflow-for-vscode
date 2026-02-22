import type WebSocket from 'ws';

/**
 * Options for connecting to an ACP WebSocket server.
 */
export interface AcpTransportOptions {
  /** WebSocket URL, e.g. ws://localhost:8090/acp */
  readonly url: string;
  /** Connection timeout in milliseconds */
  readonly timeout: number;
}

/**
 * Factory function that creates a WebSocket instance.
 * Defaults to creating a real `ws` WebSocket; overridden in tests.
 */
export type WebSocketFactory = (url: string) => WebSocket;

interface Waiter {
  readonly resolve: (msg: string) => void;
  readonly reject: (err: Error) => void;
}

/**
 * Low-level WebSocket transport for ACP.
 *
 * Uses a persistent `message` listener with a buffer/waiter pattern to
 * guarantee no messages are lost when multiple frames arrive in the same
 * TCP segment.  This replaces the SDK's one-shot listener approach that
 * required a patchTransport() monkey-patch.
 */
export class AcpTransport {
  private readonly log: (msg: string) => void;
  private ws: WebSocket | null = null;
  private connected = false;

  /** Messages received but not yet consumed by receive(). */
  private readonly buffer: string[] = [];
  /** Pending receive() callers waiting for a message. */
  private readonly waiters: Waiter[] = [];

  /** Callback invoked when the connection closes unexpectedly. */
  onClose: ((error?: Error) => void) | null = null;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Connect to an ACP WebSocket server.
   *
   * @param options  Connection URL and timeout.
   * @param wsFactory  Optional factory for creating the WebSocket instance
   *                   (useful for testing).  When omitted the real `ws`
   *                   package is used.
   */
  async connect(
    options: AcpTransportOptions,
    wsFactory?: WebSocketFactory,
  ): Promise<void> {
    if (this.connected) {
      await this.disconnect();
    }

    const ws = wsFactory
      ? wsFactory(options.url)
      : await this.createRealWebSocket(options.url);

    return new Promise<void>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        cleanup();
        this.connected = false;
        try {
          ws.close();
        } catch {
          // ignore close errors
        }
        reject(new Error(`Connection timeout after ${options.timeout} ms`));
      }, options.timeout);

      const onOpen = () => {
        cleanup();
        this.ws = ws;
        this.connected = true;
        this.installListeners(ws);
        this.log(`Connected to ${options.url}`);
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        this.connected = false;
        reject(err);
      };

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
      };

      ws.on('open', onOpen);
      ws.on('error', onError);
    });
  }

  /**
   * Gracefully close the WebSocket connection.
   */
  async disconnect(): Promise<void> {
    const ws = this.ws;
    if (!ws) { return; }

    this.connected = false;
    this.ws = null;
    this.rejectAllWaiters(new Error('Connection closed'));

    try {
      ws.close();
    } catch {
      // ignore close errors
    }

    this.log('Disconnected');
  }

  /**
   * Send a raw string to the server.
   */
  async send(data: string): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected');
    }
    this.ws.send(data);
  }

  /**
   * Wait for and return the next message from the server.
   *
   * If the buffer already has messages, the first one is returned
   * immediately.  Otherwise the call blocks until a message arrives,
   * or rejects if the connection closes.
   */
  async receive(): Promise<string> {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    if (this.buffer.length > 0) {
      return this.buffer.shift()!;
    }

    return new Promise<string>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  // ── Private helpers ────────────────────────────────────────────────

  private installListeners(ws: WebSocket): void {
    ws.on('message', (data: { toString(): string }) => {
      const msg = data.toString();
      if (this.waiters.length > 0) {
        this.waiters.shift()!.resolve(msg);
      } else {
        this.buffer.push(msg);
      }
    });

    ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      this.rejectAllWaiters(new Error('Connection closed'));
      this.onClose?.(new Error('Connection closed'));
    });

    ws.on('error', (err: Error) => {
      this.connected = false;
      this.ws = null;
      this.rejectAllWaiters(err);
      this.onClose?.(err);
    });
  }

  private rejectAllWaiters(err: Error): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(err);
    }
  }

  private async createRealWebSocket(url: string): Promise<WebSocket> {
    const WS = (await import('ws')).default;
    return new WS(url);
  }
}
