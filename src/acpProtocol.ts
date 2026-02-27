import type { AcpTransport } from './acpTransport';

type LogFn = (msg: string) => void;

/**
 * Handler for server-initiated requests (methods with an `id` that
 * require a response).
 */
export type ServerMethodHandler = (id: number, params: unknown) => Promise<unknown>;

/**
 * Handler for server-initiated notifications (methods without an `id`).
 */
export type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (err: Error) => void;
}

/**
 * JSON-RPC 2.0 protocol layer over AcpTransport.
 *
 * Handles:
 * - Client → server requests with response correlation by ID
 * - Server → client requests dispatched to registered handlers
 * - Server → client notifications dispatched to registered handlers
 *
 * Replaces the SDK's Protocol class and eliminates the need for
 * patchQuestions / patchPermission monkey-patches.
 */
export class AcpProtocol {
  private readonly transport: AcpTransport;
  private readonly log: LogFn;

  /** Auto-incrementing request ID counter. */
  private nextId = 1;

  /** Pending client-initiated requests awaiting server responses. */
  private readonly pendingRequests = new Map<number, PendingRequest>();

  /** Registered handlers for server-initiated requests (have an id). */
  private readonly serverMethodHandlers = new Map<string, ServerMethodHandler>();

  /** Registered handlers for server-initiated notifications (no id). */
  private readonly notificationHandlers = new Map<string, NotificationHandler>();

  /** Whether the receive loop is running. */
  private running = false;
  private readonly errorDataPreviewLimit = 240;

  constructor(transport: AcpTransport, log: LogFn) {
    this.transport = transport;
    this.log = log;
  }

  // ── Client → Server ────────────────────────────────────────────────

  /**
   * Send a JSON-RPC request and return a Promise that resolves with
   * the server's result, or rejects on error.
   */
  sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const request = {
      jsonrpc: '2.0' as const,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.transport.send(JSON.stringify(request)).catch((err: unknown) => {
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /**
   * Respond to a server-initiated request with a result.
   */
  async sendResult(id: number, result: unknown): Promise<void> {
    const response = { jsonrpc: '2.0' as const, id, result };
    await this.transport.send(JSON.stringify(response));
  }

  /**
   * Respond to a server-initiated request with an error.
   */
  async sendError(id: number, code: number, message: string): Promise<void> {
    const response = {
      jsonrpc: '2.0' as const,
      id,
      error: { code, message },
    };
    await this.transport.send(JSON.stringify(response));
  }

  // ── Server → Client handler registration ───────────────────────────

  /**
   * Register a handler for a server-initiated request (has `id`).
   * The handler's return value is sent back as the JSON-RPC result.
   */
  onServerMethod(method: string, handler: ServerMethodHandler): void {
    this.serverMethodHandlers.set(method, handler);
  }

  /**
   * Register a handler for a server-initiated notification (no `id`).
   */
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  // ── Receive loop ──────────────────────────────────────────────────

  /**
   * Start the background receive loop that reads messages from the
   * transport and routes them to the appropriate handler.
   */
  startReceiveLoop(): void {
    if (this.running) { return; }
    this.running = true;
    this.receiveLoop();
  }

  /**
   * Stop the receive loop.
   */
  stopReceiveLoop(): void {
    this.running = false;
  }

  /**
   * Stop the receive loop and reject all pending requests.
   */
  dispose(): void {
    this.stopReceiveLoop();
    const err = new Error('Protocol disposed');
    for (const pending of this.pendingRequests.values()) {
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  // ── Private ────────────────────────────────────────────────────────

  private async receiveLoop(): Promise<void> {
    while (this.running) {
      let raw: string;
      try {
        raw = await this.transport.receive();
      } catch {
        // Transport closed or errored — stop loop
        this.running = false;
        break;
      }

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw);
      } catch {
        if (raw.trimStart().startsWith('//')) {
          continue;
        }
        this.log(`Ignoring malformed JSON: ${raw.substring(0, 100)}`);
        continue;
      }

      this.routeMessage(message);
    }
  }

  private routeMessage(message: Record<string, unknown>): void {
    const id = message.id as number | undefined;
    const method = message.method as string | undefined;

    // Case 1: Response to a client-initiated request
    if (id !== undefined && !method) {
      const pending = this.pendingRequests.get(id);
      if (!pending) {
        this.log(`Received response for unknown request id=${id}`);
        return;
      }
      this.pendingRequests.delete(id);

      if (message.error) {
        pending.reject(new Error(this.formatJsonRpcError(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Case 2: Server-initiated request (has both id and method)
    if (id !== undefined && method) {
      const handler = this.serverMethodHandlers.get(method);
      if (!handler) {
        this.log(`No handler for server method: ${method}`);
        this.sendError(id, -32601, `Method not found: ${method}`).catch(() => {});
        return;
      }

      handler(id, message.params)
        .then((result) => this.sendResult(id, result))
        .catch((err: Error) =>
          this.sendError(id, -32603, err.message || 'Handler failed'),
        );
      return;
    }

    // Case 3: Notification (has method but no id)
    if (method && id === undefined) {
      const handler = this.notificationHandlers.get(method);
      if (handler) {
        handler(message.params);
      }
      // Silently ignore unregistered notifications
      return;
    }

    this.log(`Unroutable message: ${JSON.stringify(message).substring(0, 200)}`);
  }

  private formatJsonRpcError(errorPayload: unknown): string {
    if (!this.isRecord(errorPayload)) {
      return '[JSON-RPC] Unknown JSON-RPC error';
    }

    const code = typeof errorPayload.code === 'number' ? errorPayload.code : undefined;
    const rawMessage = typeof errorPayload.message === 'string'
      ? errorPayload.message.trim()
      : '';
    const dataSummary = this.summarizeErrorData(errorPayload.data);

    let message = rawMessage;
    if (!message) {
      message = dataSummary || 'Unknown JSON-RPC error';
    } else if (dataSummary) {
      message = `${message} (data: ${dataSummary})`;
    }

    return code !== undefined
      ? `[JSON-RPC ${code}] ${message}`
      : `[JSON-RPC] ${message}`;
  }

  private summarizeErrorData(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      return this.truncateForError(trimmed);
    }

    try {
      return this.truncateForError(JSON.stringify(value));
    } catch {
      return this.truncateForError(String(value));
    }
  }

  private truncateForError(value: string): string {
    if (value.length <= this.errorDataPreviewLimit) {
      return value;
    }
    const tail = value.length - this.errorDataPreviewLimit;
    return `${value.slice(0, this.errorDataPreviewLimit)}... [truncated ${tail} chars]`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
