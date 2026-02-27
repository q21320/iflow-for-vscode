import WebSocket = require('ws');

export type WebSocketFactory = (url: string, options?: { handshakeTimeout?: number }) => WebSocket;

interface ProbeAttemptResult {
  success: boolean;
  error?: Error;
}

export interface WebSocketReadinessProbeOptions {
  createWebSocket: WebSocketFactory;
  getWebSocketUrl: () => string;
  maxAttempts: number;
  retryIntervalMs: number;
  handshakeTimeoutMs: number;
  connectionTimeoutMs: number;
  isCancelled: () => boolean;
  onFirstFailure?: (message: string) => void;
}

export interface WebSocketReadinessResult {
  ready: boolean;
  attempts: number;
}

export async function waitForWebSocketReadiness(
  options: WebSocketReadinessProbeOptions,
): Promise<WebSocketReadinessResult> {
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    if (options.isCancelled()) {
      return { ready: false, attempts: attempt - 1 };
    }

    try {
      const result = await attemptWebSocketConnection(options, options.getWebSocketUrl());
      if (result.success) {
        return { ready: true, attempts: attempt };
      }
      if (attempt === 1 && result.error) {
        options.onFirstFailure?.(result.error.message);
      }
    } catch (error) {
      if (attempt === 1) {
        options.onFirstFailure?.(error instanceof Error ? error.message : String(error));
      }
    }

    if (attempt < options.maxAttempts && !options.isCancelled()) {
      await new Promise((resolve) => setTimeout(resolve, options.retryIntervalMs));
    }
  }

  return { ready: false, attempts: options.maxAttempts };
}

async function attemptWebSocketConnection(
  options: WebSocketReadinessProbeOptions,
  url: string,
): Promise<ProbeAttemptResult> {
  const ws = options.createWebSocket(url, { handshakeTimeout: options.handshakeTimeoutMs });
  return new Promise<ProbeAttemptResult>((resolve) => {
    let finished = false;
    let timeout: NodeJS.Timeout | null = null;

    const done = (result: ProbeAttemptResult): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
      resolve(result);
    };

    ws.on('open', () => done({ success: true }));
    ws.on('error', (error: Error) => done({ success: false, error }));
    ws.on('close', () => done({ success: false, error: new Error('Connection closed') }));

    timeout = setTimeout(() => {
      done({ success: false, error: new Error('WebSocket timeout') });
    }, options.connectionTimeoutMs);
  });
}
