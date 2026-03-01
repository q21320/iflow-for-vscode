#!/usr/bin/env node
/**
 * Basic ACP smoke test: connect to a real iflow CLI, run a simple prompt,
 * and verify session/update notifications.
 *
 * Refactored to use shared infrastructure from _acpProbeShared.mjs.
 */
import {
  safeJson,
  sleep,
  extractUsagePayload,
  spawnIflowProcess,
  connectWsWithRetry,
  createRpcHarness,
  gracefulTeardown,
  initializeAndAuthenticate,
} from './_acpProbeShared.mjs';

const port = Number(process.env.IFLOW_ACP_PORT || 8099);
const wsUrl = `ws://127.0.0.1:${port}/acp`;
const cwd = process.cwd();
const enableStream = process.env.IFLOW_ACP_STREAM === '1';
const dumpAllUpdates = process.env.IFLOW_ACP_DUMP_ALL !== '0';
const connectTimeoutMs = Number(process.env.IFLOW_ACP_CONNECT_TIMEOUT_MS || 30000);

async function main() {
  console.log(`[probe] starting iflow ACP on port ${port}`);
  const proc = spawnIflowProcess({ port, enableStream, cwd });
  const { child } = proc;

  let ws;
  try {
    ws = await connectWsWithRetry(wsUrl, connectTimeoutMs);
    console.log(`[probe] connected ${wsUrl}`);

    const harness = createRpcHarness(ws, {
      dumpUpdates: dumpAllUpdates,
      onServerMethod: (method, _id, params) => {
        // Legacy plan exit: reject in basic smoke test
        if (method === '_iflow/plan/exit') {
          return { approved: false };
        }
        return undefined; // fall through to default
      },
    });
    const { request } = harness;
    const { observers } = harness;

    await initializeAndAuthenticate(harness, (msg) => console.log(`[probe] ${msg}`));

    const sessionNew = await request('session/new', {
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

    await request('session/set_mode', { sessionId, modeId: 'default' });

    const promptResult = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply exactly OK. Do not call tools.' }],
    });
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
    console.log(`[probe] session/update notifications: ${observers.sessionUpdates.length}`);
    const byType = new Map();
    for (const n of observers.sessionUpdates) {
      byType.set(n.sessionUpdate, (byType.get(n.sessionUpdate) || 0) + 1);
    }
    for (const [type, count] of byType.entries()) {
      console.log(`[probe]   ${type}: ${count}`);
    }
    console.log(`[probe] usage found in updates: ${observers.usageInUpdates.length}`);
    if (observers.usageInUpdates.length > 0) {
      for (const hit of observers.usageInUpdates.slice(0, 5)) {
        console.log(`[probe]   update=${hit.sessionUpdate} usage=${safeJson(hit.usageHits)}`);
      }
    }
    console.log(`[probe] usage found in session/prompt result: ${promptUsageHits.length}`);
    if (promptUsageHits.length > 0) {
      console.log(`[probe]   promptResultUsage=${safeJson(promptUsageHits)}`);
    }
  } finally {
    await gracefulTeardown(ws, child);
    const stderrTail = proc.getStderrTail();
    const stdoutTail = proc.getStdoutTail();
    if (stderrTail.trim()) {
      console.log(`\n[probe] iflow stderr tail:\n${stderrTail.slice(-1200)}`);
    }
    if (stdoutTail.trim()) {
      console.log(`\n[probe] iflow stdout tail:\n${stdoutTail.slice(-1200)}`);
    }
  }
}

main().catch((err) => {
  console.error(`[probe] failed: ${err?.stack || err?.message || String(err)}`);
  process.exitCode = 1;
});
