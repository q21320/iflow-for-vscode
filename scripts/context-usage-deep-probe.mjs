#!/usr/bin/env node
/**
 * Deep Context Usage Probe
 *
 * Captures EVERY JSON-RPC message (all methods, all notifications) to find
 * where the CLI sends context usage data. The standard probe only looks at
 * session/update — this one logs everything.
 *
 * Also tries calling session-related methods to see if context usage can
 * be queried explicitly.
 */
import {
  safeJson,
  sleep,
  spawnIflowProcess,
  connectWsWithRetry,
  gracefulTeardown,
  initializeAndAuthenticate,
} from './_acpProbeShared.mjs';

const port = Number(process.env.IFLOW_ACP_PORT || 8299);
const wsUrl = `ws://127.0.0.1:${port}/acp`;
const cwd = process.cwd();

// Capture ALL messages
const allInboundMessages = [];

async function main() {
  console.log(`[deep-probe] Starting iFlow ACP on port ${port}`);
  const proc = spawnIflowProcess({ port, enableStream: true, cwd });
  const { child } = proc;
  let ws;

  try {
    ws = await connectWsWithRetry(wsUrl, 30000);
    console.log(`[deep-probe] Connected.`);

    // Raw message capture — intercept EVERYTHING
    const originalOnMessage = ws.on.bind(ws);
    const rpcPending = new Map();
    let nextId = 1;

    function send(msg) {
      ws.send(JSON.stringify(msg));
    }

    function request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        rpcPending.set(id, { resolve, reject, method });
        send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      });
    }

    function sendResult(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      allInboundMessages.push({ ...msg, _timestamp: Date.now() });

      // Response to our request
      if (typeof msg.id === 'number' && !msg.method) {
        const pending = rpcPending.get(msg.id);
        if (pending) {
          rpcPending.delete(msg.id);
          if (msg.error) {
            pending.reject(Object.assign(new Error(msg.error.message || String(msg.error)), { rpcError: msg.error }));
          } else {
            pending.resolve(msg.result);
          }
        }
        return;
      }

      // Server method call (needs response)
      if (typeof msg.id === 'number' && typeof msg.method === 'string') {
        console.log(`[deep-probe] SERVER METHOD: ${msg.method} (id=${msg.id})`);
        console.log(`[deep-probe]   params: ${safeJson(msg.params, 2000)}`);

        // Auto-handle common server methods
        if (msg.method === 'session/request_permission') {
          const opts = Array.isArray(msg.params?.options) ? msg.params.options : [];
          const allow = opts.find(o => o?.kind === 'allow_once' || o?.kind === 'allow_always') || opts[0];
          sendResult(msg.id, { outcome: { outcome: 'selected', optionId: allow?.optionId || '' } });
        } else if (msg.method === '_iflow/user/questions') {
          const questions = Array.isArray(msg.params?.questions) ? msg.params.questions : [];
          const answers = {};
          for (const q of questions) {
            if (typeof q?.header === 'string') {
              answers[q.header] = Array.isArray(q.options) ? (q.options[0]?.label || '') : '';
            }
          }
          sendResult(msg.id, { answers });
        } else if (msg.method === '_iflow/plan/exit') {
          sendResult(msg.id, { approved: false });
        } else {
          sendResult(msg.id, {});
        }
        return;
      }

      // Notification (no id)
      if (typeof msg.method === 'string') {
        console.log(`[deep-probe] NOTIFICATION: ${msg.method}`);
        console.log(`[deep-probe]   params keys: [${Object.keys(msg.params || {}).join(', ')}]`);

        // For session/update, show the update type
        if (msg.method === 'session/update') {
          const update = msg.params?.update || msg.params || {};
          console.log(`[deep-probe]   sessionUpdate: ${update.sessionUpdate || '(none)'}`);
          console.log(`[deep-probe]   update keys: [${Object.keys(update).join(', ')}]`);
        }

        // Dump full params for non-chunk notifications
        const update = msg.params?.update || {};
        if (update.sessionUpdate !== 'agent_thought_chunk' && update.sessionUpdate !== 'agent_message_chunk') {
          console.log(`[deep-probe]   FULL: ${safeJson(msg.params, 3000)}`);
        }
        return;
      }
    });

    // Phase 1: Initialize
    console.log('\n[deep-probe] === Phase 1: Initialize ===');
    const initResult = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    console.log(`[deep-probe] initialize result: ${safeJson(initResult, 2000)}`);

    if (!initResult?.isAuthenticated) {
      const authResult = await request('authenticate', { methodId: 'iflow' });
      console.log(`[deep-probe] authenticate result: ${safeJson(authResult)}`);
    }

    // Phase 2: Create session
    console.log('\n[deep-probe] === Phase 2: Create Session ===');
    const sessionResult = await request('session/new', {
      cwd,
      mcpServers: [],
      settings: { permission_mode: 'default', add_dirs: [cwd] },
    });
    const sessionId = sessionResult?.sessionId;
    console.log(`[deep-probe] session/new result: ${safeJson(sessionResult, 2000)}`);

    await request('session/set_mode', { sessionId, modeId: 'default' });

    // Phase 3: Try to query session status/context BEFORE prompt
    console.log('\n[deep-probe] === Phase 3: Try context-related methods ===');

    const methodsToTry = [
      ['session/status', { sessionId }],
      ['session/context', { sessionId }],
      ['session/usage', { sessionId }],
      ['session/get_context', { sessionId }],
      ['session/info', { sessionId }],
    ];

    for (const [method, params] of methodsToTry) {
      try {
        const result = await Promise.race([
          request(method, params),
          sleep(3000).then(() => { throw new Error('timeout'); }),
        ]);
        console.log(`[deep-probe] ${method} => ${safeJson(result, 2000)}`);
      } catch (err) {
        console.log(`[deep-probe] ${method} => ERROR: ${err.message}`);
      }
    }

    // Phase 4: Send prompt
    console.log('\n[deep-probe] === Phase 4: Send Prompt ===');
    console.log('[deep-probe] Sending: "What model are you? Reply briefly."');

    const promptResult = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'What model are you? Reply briefly.' }],
    });
    console.log(`\n[deep-probe] session/prompt result: ${safeJson(promptResult, 2000)}`);

    // Wait for trailing notifications
    await sleep(3000);

    // Phase 5: Try context methods AFTER prompt
    console.log('\n[deep-probe] === Phase 5: Try context methods AFTER prompt ===');
    for (const [method, params] of methodsToTry) {
      try {
        const result = await Promise.race([
          request(method, params),
          sleep(3000).then(() => { throw new Error('timeout'); }),
        ]);
        console.log(`[deep-probe] ${method} => ${safeJson(result, 2000)}`);
      } catch (err) {
        console.log(`[deep-probe] ${method} => ERROR: ${err.message}`);
      }
    }

    // Phase 6: Send second prompt to see if usage appears after accumulation
    console.log('\n[deep-probe] === Phase 6: Second Prompt ===');
    const promptResult2 = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply exactly OK.' }],
    });
    console.log(`\n[deep-probe] Second session/prompt result: ${safeJson(promptResult2, 2000)}`);

    await sleep(2000);

    // Phase 7: Full analysis
    console.log('\n[deep-probe] ════════════════════════════════════════');
    console.log('[deep-probe] FULL MESSAGE ANALYSIS');
    console.log('[deep-probe] ════════════════════════════════════════');
    console.log(`[deep-probe] Total inbound messages: ${allInboundMessages.length}`);

    // Group by type
    const notifications = allInboundMessages.filter(m => typeof m.method === 'string' && m.id === undefined);
    const serverCalls = allInboundMessages.filter(m => typeof m.method === 'string' && typeof m.id === 'number');
    const responses = allInboundMessages.filter(m => m.id !== undefined && !m.method);

    console.log(`[deep-probe] Notifications: ${notifications.length}`);
    console.log(`[deep-probe] Server method calls: ${serverCalls.length}`);
    console.log(`[deep-probe] Responses: ${responses.length}`);

    // List ALL unique notification methods
    const notifMethods = new Map();
    for (const n of notifications) {
      notifMethods.set(n.method, (notifMethods.get(n.method) || 0) + 1);
    }
    console.log('\n[deep-probe] Notification methods:');
    for (const [method, count] of notifMethods.entries()) {
      console.log(`[deep-probe]   ${method}: ${count}`);
    }

    // List ALL unique server method calls
    const serverMethods = new Map();
    for (const s of serverCalls) {
      serverMethods.set(s.method, (serverMethods.get(s.method) || 0) + 1);
    }
    console.log('\n[deep-probe] Server methods called:');
    for (const [method, count] of serverMethods.entries()) {
      console.log(`[deep-probe]   ${method}: ${count}`);
    }

    // Deep scan ALL messages for any usage-related keywords
    console.log('\n[deep-probe] Deep scan for usage-related keywords...');
    const usageKeywords = ['token', 'usage', 'context', 'remaining', 'consumed', 'cost', 'percent', 'quota'];

    for (const msg of allInboundMessages) {
      const jsonStr = JSON.stringify(msg).toLowerCase();
      const foundKeywords = usageKeywords.filter(kw => jsonStr.includes(kw));
      if (foundKeywords.length > 0) {
        // Filter out false positives (like "context" in cwd paths)
        const meaningfulHits = foundKeywords.filter(kw => {
          if (kw === 'context') {
            // Check if it's just a path reference
            return !jsonStr.includes('idecontext') && (jsonStr.includes('"context"') || jsonStr.includes('context_'));
          }
          return true;
        });
        if (meaningfulHits.length > 0) {
          const label = msg.method ? `${msg.method}` : `response(id=${msg.id})`;
          console.log(`[deep-probe]   ${label}: found keywords: ${meaningfulHits.join(', ')}`);
          console.log(`[deep-probe]     => ${safeJson(msg, 500)}`);
        }
      }
    }

  } catch (err) {
    console.error(`[deep-probe] ERROR: ${err?.stack || err?.message || String(err)}`);
  } finally {
    await gracefulTeardown(ws, child);
    const stderrTail = proc.getStderrTail();
    if (stderrTail.trim()) {
      console.log(`\n[deep-probe] iflow stderr:\n${stderrTail.slice(-1000)}`);
    }
  }
}

main().catch(err => {
  console.error(`[deep-probe] fatal: ${err?.stack || err?.message || String(err)}`);
  process.exitCode = 1;
});
