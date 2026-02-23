#!/usr/bin/env node
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const port = Number(process.env.IFLOW_ACP_PORT || 8099);
const wsUrl = `ws://127.0.0.1:${port}/acp`;
const cwd = process.cwd();
const enableStream = process.env.IFLOW_ACP_STREAM === '1';
const dumpAllUpdates = process.env.IFLOW_ACP_DUMP_ALL !== '0';
const connectTimeoutMs = Number(process.env.IFLOW_ACP_CONNECT_TIMEOUT_MS || 30000);

const rpc = {
  nextId: 1,
  pending: new Map(),
};

const observed = {
  notifications: [],
  promptResponse: null,
  usageInUpdates: [],
};

function safeJson(value, max = 1200) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstNumber(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function extractUsagePayload(source) {
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

function scanUsage(update) {
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

function createRpcClient(ws) {
  function send(message) {
    ws.send(JSON.stringify(message));
  }

  function sendResult(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function sendError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  function handleServerMethod(msg) {
    const method = msg.method;
    const id = msg.id;
    const params = msg.params || {};

    if (method === 'session/request_permission') {
      const options = Array.isArray(params.options) ? params.options : [];
      const allow = options.find((o) => o?.kind === 'allow_once' || o?.kind === 'allow_always') || options[0];
      if (allow?.optionId) {
        sendResult(id, { outcome: { outcome: 'selected', optionId: allow.optionId } });
      } else {
        sendResult(id, { outcome: { outcome: 'cancelled' } });
      }
      return;
    }

    if (method === '_iflow/user/questions') {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      const answers = {};
      for (const q of questions) {
        if (typeof q?.header !== 'string') {
          continue;
        }
        const option = Array.isArray(q.options) ? q.options[0] : null;
        answers[q.header] = option?.label || '';
      }
      sendResult(id, { answers });
      return;
    }

    if (method === '_iflow/plan/exit') {
      sendResult(id, { approved: false });
      return;
    }

    if (method === 'fs/read_text_file') {
      sendResult(id, { error: 'not handled in probe' });
      return;
    }

    if (method === 'fs/write_text_file') {
      sendResult(id, { error: 'not handled in probe' });
      return;
    }

    sendError(id, -32601, `Unhandled method: ${method}`);
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      console.log(`[probe] ignoring non-json: ${String(raw).slice(0, 300)}`);
      return;
    }

    if (typeof msg.id === 'number' && !msg.method) {
      const pending = rpc.pending.get(msg.id);
      if (!pending) {
        return;
      }
      rpc.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || String(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      handleServerMethod(msg);
      return;
    }

    if (typeof msg.method === 'string') {
      if (msg.method === 'session/update') {
        const envelope = msg.params && typeof msg.params === 'object' ? msg.params : {};
        const update = envelope.update || msg.params || {};
        if (dumpAllUpdates) {
          console.log(`[probe] raw session/update envelope => ${safeJson(msg.params, 3000)}`);
        }
        const usageHits = scanUsage(update);
        observed.notifications.push({
          sessionUpdate: update?.sessionUpdate || '(none)',
          usageHits,
        });
        if (usageHits.length > 0) {
          observed.usageInUpdates.push({
            sessionUpdate: update?.sessionUpdate || '(none)',
            usageHits,
            raw: safeJson(update, 2000),
          });
        }
      }
      return;
    }
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

  return { request };
}

async function connectWsWithRetry(timeoutMs = connectTimeoutMs) {
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

async function main() {
  console.log(`[probe] starting iflow ACP on port ${port}`);
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
    if (stdoutBuf.length > 6000) {
      stdoutBuf = stdoutBuf.slice(-6000);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrBuf += String(chunk);
    if (stderrBuf.length > 6000) {
      stderrBuf = stderrBuf.slice(-6000);
    }
  });

  let ws;
  try {
    ws = await connectWsWithRetry();
    console.log(`[probe] connected ${wsUrl}`);
    const client = createRpcClient(ws);

    const initResult = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
    console.log(`[probe] initialize => ${safeJson(initResult)}`);

    if (!initResult?.isAuthenticated) {
      const authResult = await client.request('authenticate', { methodId: 'iflow' });
      console.log(`[probe] authenticate => ${safeJson(authResult)}`);
    }

    const sessionNew = await client.request('session/new', {
      cwd,
      mcpServers: [],
      settings: {
        permission_mode: 'default',
        add_dirs: [cwd],
      },
    });
    const sessionId = sessionNew?.sessionId;
    if (!sessionId) {
      throw new Error(`session/new returned no sessionId: ${safeJson(sessionNew)}`);
    }
    console.log(`[probe] session/new => sessionId=${sessionId}`);

    await client.request('session/set_mode', { sessionId, modeId: 'default' });

    const promptResult = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply exactly OK. Do not call tools.' }],
    });
    observed.promptResponse = promptResult;
    console.log(`[probe] session/prompt result => ${safeJson(promptResult, 3000)}`);

    await sleep(1500);

    const promptUsageHits = [];
    if (promptResult && typeof promptResult === 'object') {
      for (const path of ['usageMetadata', 'usage', 'tokenUsage']) {
        const payload = extractUsagePayload(promptResult[path]);
        if (payload) {
          promptUsageHits.push({ path, ...payload });
        }
      }
    }

    console.log('\n[probe] summary');
    console.log(`[probe] session/update notifications: ${observed.notifications.length}`);
    const byType = new Map();
    for (const n of observed.notifications) {
      byType.set(n.sessionUpdate, (byType.get(n.sessionUpdate) || 0) + 1);
    }
    for (const [type, count] of byType.entries()) {
      console.log(`[probe]   ${type}: ${count}`);
    }
    console.log(`[probe] usage found in updates: ${observed.usageInUpdates.length}`);
    if (observed.usageInUpdates.length > 0) {
      for (const hit of observed.usageInUpdates.slice(0, 5)) {
        console.log(`[probe]   update=${hit.sessionUpdate} usage=${safeJson(hit.usageHits)}`);
      }
    }
    console.log(`[probe] usage found in session/prompt result: ${promptUsageHits.length}`);
    if (promptUsageHits.length > 0) {
      console.log(`[probe]   promptResultUsage=${safeJson(promptUsageHits)}`);
    }
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    child.kill('SIGTERM');
    await sleep(200);
    if (!child.killed) {
      child.kill('SIGKILL');
    }
    if (stderrBuf.trim()) {
      console.log(`\n[probe] iflow stderr tail:\n${stderrBuf.slice(-1200)}`);
    }
    if (stdoutBuf.trim()) {
      console.log(`\n[probe] iflow stdout tail:\n${stdoutBuf.slice(-1200)}`);
    }
  }
}

main().catch((err) => {
  console.error(`[probe] failed: ${err?.stack || err?.message || String(err)}`);
  process.exitCode = 1;
});
