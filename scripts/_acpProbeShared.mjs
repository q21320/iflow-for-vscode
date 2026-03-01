#!/usr/bin/env node
/**
 * Shared ACP test infrastructure for real CLI smoke tests.
 *
 * Extracted from iflow-sdk-edit-test.mjs to avoid duplication between
 * the basic smoke test and the plan-mode E2E test.
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

// ── Utility helpers ────────────────────────────────────────────────

export function safeJson(value, max = 1200) {
  try {
    const text = JSON.stringify(value);
    if (text.length <= max) {
      return text;
    }
    return `${text.slice(0, max)}... [truncated ${text.length - max} chars]`;
  } catch {
    return String(value);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function firstNumber(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function extractUsagePayload(source) {
  if (!source || typeof source !== 'object') {
    return null;
  }
  const promptTokens = firstNumber(source, ['promptTokenCount', 'prompt_tokens', 'input_tokens']);
  const completionTokens = firstNumber(source, ['candidatesTokenCount', 'completion_tokens', 'output_tokens']);
  const totalTokens = firstNumber(source, ['totalTokenCount', 'total_tokens']);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens };
}

export function scanUsage(update) {
  if (!update || typeof update !== 'object') {
    return [];
  }
  const candidates = [
    ['usageMetadata', update.usageMetadata],
    ['usage', update.usage],
    ['tokenUsage', update.tokenUsage],
    ['output', update.output],
    ['content', update.content],
  ];
  const hits = [];
  for (const [path, value] of candidates) {
    const payload = extractUsagePayload(value);
    if (payload) {
      hits.push({ path, ...payload });
    }
  }
  return hits;
}

// ── Phase timeout wrapper ──────────────────────────────────────────

export function withPhaseTimeout(phaseName, fn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Phase "${phaseName}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ── Process management ─────────────────────────────────────────────

const STDOUT_TAIL_MAX = 6000;

export function spawnIflowProcess(config) {
  const { port, enableStream = true, cwd = process.cwd() } = config;

  const args = ['--experimental-acp', '--port', String(port)];
  if (enableStream) {
    args.push('--stream');
  }

  const child = spawn('iflow', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let stdoutBuf = '';
  let stderrBuf = '';

  child.stdout.on('data', (chunk) => {
    stdoutBuf += String(chunk);
    if (stdoutBuf.length > STDOUT_TAIL_MAX) {
      stdoutBuf = stdoutBuf.slice(-STDOUT_TAIL_MAX);
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrBuf += String(chunk);
    if (stderrBuf.length > STDOUT_TAIL_MAX) {
      stderrBuf = stderrBuf.slice(-STDOUT_TAIL_MAX);
    }
  });

  return {
    child,
    getStdoutTail: () => stdoutBuf,
    getStderrTail: () => stderrBuf,
  };
}

// ── WebSocket connection ───────────────────────────────────────────

export async function connectWsWithRetry(wsUrl, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ws = await new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl);
        const t = setTimeout(() => {
          socket.close();
          reject(new Error('websocket open timeout'));
        }, 2000);
        socket.once('open', () => {
          clearTimeout(t);
          resolve(socket);
        });
        socket.once('error', (err) => {
          clearTimeout(t);
          reject(err);
        });
      });
      return ws;
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`failed to connect to ${wsUrl} within ${timeoutMs}ms`);
}

// ── JSON-RPC harness ───────────────────────────────────────────────

/**
 * Create a JSON-RPC 2.0 client with server method dispatch.
 *
 * @param {WebSocket} ws - The connected WebSocket
 * @param {object} options
 * @param {function} [options.onServerMethod] - Custom server method handler.
 *   Called with (method, id, params). Return a value to send as result.
 *   Return undefined to use the default handler.
 * @param {function} [options.onNotification] - Custom notification handler.
 *   Called with (method, params).
 * @param {boolean} [options.dumpUpdates=false] - Whether to log all session/update envelopes.
 * @returns {{ request, observers }}
 */
export function createRpcHarness(ws, options = {}) {
  const {
    onServerMethod,
    onNotification,
    dumpUpdates = false,
  } = options;

  const rpc = { nextId: 1, pending: new Map() };

  const observers = {
    sessionUpdates: [],
    usageInUpdates: [],
    serverMethodCalls: [],
  };

  function send(message) {
    ws.send(JSON.stringify(message));
  }

  function sendResult(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function sendError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  function defaultServerMethodHandler(method, id, params) {
    if (method === 'session/request_permission') {
      const permOptions = Array.isArray(params.options) ? params.options : [];
      const allow = permOptions.find((o) => o?.kind === 'allow_once' || o?.kind === 'allow_always') || permOptions[0];
      if (allow?.optionId) {
        return { outcome: { outcome: 'selected', optionId: allow.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    }

    if (method === '_iflow/user/questions') {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      const answers = {};
      for (const q of questions) {
        if (typeof q?.header !== 'string') continue;
        const option = Array.isArray(q.options) ? q.options[0] : null;
        answers[q.header] = option?.label || '';
      }
      return { answers };
    }

    if (method === 'fs/read_text_file' || method === 'fs/write_text_file') {
      return { error: 'not handled in test probe' };
    }

    return undefined;
  }

  function handleServerMethod(msg) {
    const { method, id } = msg;
    const params = msg.params || {};

    observers.serverMethodCalls.push({ method, id, params, timestamp: Date.now() });

    // Try custom handler first
    if (onServerMethod) {
      const customResult = onServerMethod(method, id, params);
      if (customResult !== undefined) {
        sendResult(id, customResult);
        return;
      }
    }

    // Fallback to default
    const defaultResult = defaultServerMethodHandler(method, id, params);
    if (defaultResult !== undefined) {
      sendResult(id, defaultResult);
      return;
    }

    sendError(id, -32601, `Unhandled method: ${method}`);
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    // Response to client request
    if (typeof msg.id === 'number' && !msg.method) {
      const pending = rpc.pending.get(msg.id);
      if (!pending) return;
      rpc.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || String(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server method request
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      handleServerMethod(msg);
      return;
    }

    // Notification
    if (typeof msg.method === 'string') {
      if (msg.method === 'session/update') {
        const envelope = msg.params && typeof msg.params === 'object' ? msg.params : {};
        const update = envelope.update || msg.params || {};
        if (dumpUpdates) {
          console.log(`[probe] raw session/update => ${safeJson(msg.params, 3000)}`);
        }
        const usageHits = scanUsage(update);
        observers.sessionUpdates.push({
          sessionUpdate: update?.sessionUpdate || '(none)',
          usageHits,
          timestamp: Date.now(),
        });
        if (usageHits.length > 0) {
          observers.usageInUpdates.push({
            sessionUpdate: update?.sessionUpdate || '(none)',
            usageHits,
          });
        }
      }
      onNotification?.(msg.method, msg.params);
      return;
    }
  });

  // Auto-reject pending RPC on WS close/error
  ws.on('close', () => {
    rejectAllPending('WebSocket connection closed');
  });
  ws.on('error', (err) => {
    rejectAllPending(`WebSocket error: ${err?.message || 'unknown'}`);
  });

  function request(method, params) {
    const id = rpc.nextId++;
    return new Promise((resolve, reject) => {
      rpc.pending.set(id, { resolve, reject });
      send({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
    });
  }

  function getPendingCount() {
    return rpc.pending.size;
  }

  function rejectAllPending(reason) {
    for (const pending of rpc.pending.values()) {
      pending.reject(new Error(reason));
    }
    rpc.pending.clear();
  }

  return { request, observers, getPendingCount, rejectAllPending };
}

// ── Graceful teardown ──────────────────────────────────────────────

export async function gracefulTeardown(ws, child) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  if (child) {
    child.kill('SIGTERM');
    // Wait for graceful exit
    const exited = await Promise.race([
      new Promise((resolve) => child.on('exit', () => resolve(true))),
      sleep(2000).then(() => false),
    ]);
    if (!exited && child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }
}

// ── Initialize + Authenticate ──────────────────────────────────────

export async function initializeAndAuthenticate(client, log = console.log) {
  const initResult = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
  });
  log(`initialize => ${safeJson(initResult)}`);

  if (!initResult?.isAuthenticated) {
    const authResult = await client.request('authenticate', { methodId: 'iflow' });
    log(`authenticate => ${safeJson(authResult)}`);
  }

  return initResult;
}
