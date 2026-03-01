#!/usr/bin/env node
/**
 * Context Usage Integration Probe
 *
 * Connects to a real iFlow CLI via WebSocket ACP, sends a simple prompt, and
 * captures ALL notification payloads to determine:
 *   1. Whether the CLI sends token/usage data in session/update notifications
 *   2. Whether the CLI sends token/usage data in the session/prompt result
 *   3. Whether the extension's extraction logic (key names) matches what the CLI sends
 *
 * Usage:
 *   node scripts/context-usage-probe.mjs
 *
 * Environment variables:
 *   IFLOW_ACP_PORT       WebSocket port (default: 8099)
 *   IFLOW_ACP_STREAM     Enable --stream flag (default: 1)
 *   IFLOW_ACP_DUMP_ALL   Dump all raw session/update payloads (default: 1)
 *   IFLOW_ACP_CONNECT_TIMEOUT_MS  Connect timeout in ms (default: 30000)
 */
import {
  safeJson,
  sleep,
  spawnIflowProcess,
  connectWsWithRetry,
  createRpcHarness,
  gracefulTeardown,
  initializeAndAuthenticate,
} from './_acpProbeShared.mjs';

// ── Config ─────────────────────────────────────────────────────────
const port = Number(process.env.IFLOW_ACP_PORT || 8099);
const wsUrl = `ws://127.0.0.1:${port}/acp`;
const cwd = process.cwd();
const enableStream = process.env.IFLOW_ACP_STREAM !== '0';
const dumpAllUpdates = process.env.IFLOW_ACP_DUMP_ALL !== '0';
const connectTimeoutMs = Number(process.env.IFLOW_ACP_CONNECT_TIMEOUT_MS || 30000);

// ── Usage key sets (mirrors usageChunkMapper.ts) ───────────────────
const PROMPT_TOKEN_KEYS = ['promptTokenCount', 'prompt_tokens', 'input_tokens'];
const COMPLETION_TOKEN_KEYS = ['candidatesTokenCount', 'completion_tokens', 'output_tokens'];
const TOTAL_TOKEN_KEYS = ['totalTokenCount', 'total_tokens'];
const ALL_USAGE_KEYS = [...PROMPT_TOKEN_KEYS, ...COMPLETION_TOKEN_KEYS, ...TOTAL_TOKEN_KEYS];
const USAGE_CONTAINER_KEYS = [
  'usageMetadata', 'usage', 'tokenUsage', 'token_usage',
  'result', 'data', 'response', 'output', 'content', 'meta', 'metadata',
];

/**
 * Deep-scan an object for any token count keys, up to the given depth.
 * Returns an array of { path, key, value } for each hit found.
 */
function deepScanForUsageKeys(obj, maxDepth = 5, currentPath = '', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > maxDepth) {
    return [];
  }
  const hits = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = currentPath ? `${currentPath}.${k}` : k;
    if (ALL_USAGE_KEYS.includes(k) && typeof v === 'number') {
      hits.push({ path, key: k, value: v });
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      hits.push(...deepScanForUsageKeys(v, maxDepth, path, depth + 1));
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === 'object') {
          hits.push(...deepScanForUsageKeys(item, maxDepth, `${path}[${i}]`, depth + 1));
        }
      });
    }
  }
  return hits;
}

/**
 * Collect top-level keys from an object at a specific field path.
 */
function describeTopLevelKeys(obj, fieldPath) {
  const parts = fieldPath.split('.');
  let cursor = obj;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return null;
    cursor = cursor[part];
  }
  if (!cursor || typeof cursor !== 'object') return null;
  return Object.keys(cursor);
}

// ── Collector for raw notification state ──────────────────────────
const allUpdates = [];
const allServerMethodCalls = [];

async function main() {
  console.log(`[usage-probe] Starting iFlow ACP on port ${port}, stream=${enableStream}`);
  console.log(`[usage-probe] This probe verifies the context usage data pipeline`);
  console.log(`[usage-probe] Expected CLI usage keys: PROMPT=${PROMPT_TOKEN_KEYS.join('|')} COMPLETION=${COMPLETION_TOKEN_KEYS.join('|')} TOTAL=${TOTAL_TOKEN_KEYS.join('|')}`);
  console.log('');

  const proc = spawnIflowProcess({ port, enableStream, cwd });
  const { child } = proc;

  let ws;
  let testPassed = true;
  const failures = [];

  try {
    // ── Phase 1: Connect ──────────────────────────────────────────
    console.log(`[usage-probe] Connecting to ${wsUrl}...`);
    ws = await connectWsWithRetry(wsUrl, connectTimeoutMs);
    console.log(`[usage-probe] Connected.`);

    // ── Phase 2: Set up harness with full notification capture ────
    const harness = createRpcHarness(ws, {
      dumpUpdates: dumpAllUpdates,
      onNotification: (method, params) => {
        if (method === 'session/update') {
          // Capture the full raw payload for analysis
          allUpdates.push({ method, params, timestamp: Date.now() });
        }
      },
      onServerMethod: (method, _id, params) => {
        allServerMethodCalls.push({ method, params, timestamp: Date.now() });
        if (method === '_iflow/plan/exit') {
          return { approved: false };
        }
        return undefined;
      },
    });
    const { request, observers } = harness;

    // ── Phase 3: Initialize and authenticate ─────────────────────
    console.log('[usage-probe] Initializing...');
    await initializeAndAuthenticate(harness, (msg) => console.log(`[usage-probe] ${msg}`));

    // ── Phase 4: Create session ───────────────────────────────────
    console.log('[usage-probe] Creating session...');
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
    console.log(`[usage-probe] Session created: sessionId=${sessionId}`);

    await request('session/set_mode', { sessionId, modeId: 'default' });

    // ── Phase 5: Send prompt ──────────────────────────────────────
    console.log('[usage-probe] Sending prompt...');
    console.log('[usage-probe] Prompt: "Reply exactly OK. Do not call tools."');
    const promptResult = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply exactly OK. Do not call tools.' }],
    });
    console.log(`[usage-probe] session/prompt result received.`);
    console.log(`[usage-probe] Raw result: ${safeJson(promptResult, 4000)}`);

    // Give notifications time to arrive
    await sleep(2000);

    // ── Phase 6: Analyze session/update notifications ─────────────
    console.log('\n[usage-probe] ═══════════════════════════════════════════');
    console.log('[usage-probe] ANALYSIS: session/update notifications');
    console.log('[usage-probe] ═══════════════════════════════════════════');
    console.log(`[usage-probe] Total session/update notifications: ${allUpdates.length}`);

    const updatesByType = new Map();
    for (const n of allUpdates) {
      const update = n.params?.update || n.params || {};
      const sessionUpdateType = update?.sessionUpdate || '(none)';
      updatesByType.set(sessionUpdateType, (updatesByType.get(sessionUpdateType) || 0) + 1);
    }
    console.log('[usage-probe] Update types seen:');
    for (const [type, count] of updatesByType.entries()) {
      console.log(`[usage-probe]   ${type}: ${count}`);
    }

    // Scan each notification for usage data
    console.log('\n[usage-probe] Scanning all notifications for usage keys...');
    let updatesWithUsage = 0;
    const usageKeyFrequency = new Map();

    for (const n of allUpdates) {
      const rawParams = n.params;
      const hits = deepScanForUsageKeys(rawParams);
      if (hits.length > 0) {
        updatesWithUsage++;
        const envelope = rawParams?.update || rawParams || {};
        const sessionUpdateType = envelope?.sessionUpdate || '(none)';
        console.log(`[usage-probe]   update(${sessionUpdateType}): found usage keys: ${hits.map(h => `${h.path}=${h.value}`).join(', ')}`);
        for (const hit of hits) {
          usageKeyFrequency.set(hit.key, (usageKeyFrequency.get(hit.key) || 0) + 1);
        }
      }
    }

    if (updatesWithUsage === 0) {
      console.log('[usage-probe]   (no usage keys found in any notification)');
    }

    // Report which specific keys were found
    console.log(`\n[usage-probe] Notifications containing usage keys: ${updatesWithUsage}/${allUpdates.length}`);
    if (usageKeyFrequency.size > 0) {
      console.log('[usage-probe] Usage key occurrences:');
      for (const [key, count] of usageKeyFrequency.entries()) {
        const category =
          PROMPT_TOKEN_KEYS.includes(key) ? 'PROMPT' :
          COMPLETION_TOKEN_KEYS.includes(key) ? 'COMPLETION' :
          TOTAL_TOKEN_KEYS.includes(key) ? 'TOTAL' : 'UNKNOWN';
        console.log(`[usage-probe]   ${key}: ${count} (category: ${category})`);
      }
    }

    // ── Phase 7: Check the envelope structure more carefully ──────
    console.log('\n[usage-probe] ═══════════════════════════════════════════');
    console.log('[usage-probe] ANALYSIS: Notification envelope structure');
    console.log('[usage-probe] ═══════════════════════════════════════════');

    // Sample first 3 notifications
    for (const [idx, n] of allUpdates.slice(0, 3).entries()) {
      const topLevelKeys = Object.keys(n.params || {});
      const update = n.params?.update || n.params || {};
      const updateKeys = Object.keys(update);
      console.log(`[usage-probe] Notification #${idx + 1}:`);
      console.log(`[usage-probe]   envelope top-level keys: [${topLevelKeys.join(', ')}]`);
      console.log(`[usage-probe]   update keys: [${updateKeys.join(', ')}]`);
      // Check presence of usage container keys in update
      for (const containerKey of ['usageMetadata', 'usage', 'tokenUsage']) {
        if (update[containerKey] !== undefined) {
          console.log(`[usage-probe]   update.${containerKey}: ${safeJson(update[containerKey])}`);
        }
      }
    }

    // ── Phase 8: Analyze session/prompt result ────────────────────
    console.log('\n[usage-probe] ═══════════════════════════════════════════');
    console.log('[usage-probe] ANALYSIS: session/prompt result');
    console.log('[usage-probe] ═══════════════════════════════════════════');

    const resultTopLevelKeys = promptResult && typeof promptResult === 'object'
      ? Object.keys(promptResult)
      : [];
    console.log(`[usage-probe] session/prompt result top-level keys: [${resultTopLevelKeys.join(', ')}]`);

    // Check for usage in the result at all depths
    const resultUsageHits = deepScanForUsageKeys(promptResult);
    if (resultUsageHits.length > 0) {
      console.log(`[usage-probe] Usage keys found in session/prompt result:`);
      for (const hit of resultUsageHits) {
        const category =
          PROMPT_TOKEN_KEYS.includes(hit.key) ? 'PROMPT' :
          COMPLETION_TOKEN_KEYS.includes(hit.key) ? 'COMPLETION' :
          TOTAL_TOKEN_KEYS.includes(hit.key) ? 'TOTAL' : 'UNKNOWN';
        console.log(`[usage-probe]   path=${hit.path}, key=${hit.key}, value=${hit.value}, category=${category}`);
      }
    } else {
      console.log('[usage-probe] No known usage keys found in session/prompt result.');
      console.log('[usage-probe] This means extension will log: "[ACP] No usage data found in session/prompt result"');
    }

    // Check well-known container keys in the result
    if (promptResult && typeof promptResult === 'object') {
      for (const containerKey of USAGE_CONTAINER_KEYS) {
        if (promptResult[containerKey] !== undefined) {
          console.log(`[usage-probe]   result.${containerKey} = ${safeJson(promptResult[containerKey])}`);
        }
      }
    }

    // ── Phase 9: Check what SHOULD map to usageChunk ─────────────
    console.log('\n[usage-probe] ═══════════════════════════════════════════');
    console.log('[usage-probe] ANALYSIS: Extension pipeline simulation');
    console.log('[usage-probe] ═══════════════════════════════════════════');

    // Simulate what the extension's UsageChunkMapper would extract
    let usageChunksFromUpdates = 0;
    let usageChunksFromResult = 0;

    for (const n of allUpdates) {
      const envelope = n.params || {};
      const update = envelope.update ?? envelope;
      if (!update || typeof update !== 'object') continue;

      // Simulate AcpUsageExtractor.mergeEnvelopeUsage
      const merged = { ...update };
      for (const key of ['usageMetadata', 'usage', 'tokenUsage']) {
        if (envelope[key] !== undefined && merged[key] === undefined) {
          merged[key] = envelope[key];
        }
      }

      // Simulate UsageChunkMapper.extractFromUpdate
      const candidates = [merged.usageMetadata, merged.usage, merged.tokenUsage, merged.output, merged.content];
      const promptTokens = findFirst(candidates, PROMPT_TOKEN_KEYS);
      const completionTokens = findFirst(candidates, COMPLETION_TOKEN_KEYS);
      const totalTokens = findFirst(candidates, TOTAL_TOKEN_KEYS);

      if (promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined) {
        usageChunksFromUpdates++;
      }
    }

    // Simulate UsageChunkMapper.extractFromPayload on the promptResult
    if (promptResult && typeof promptResult === 'object') {
      const candidates = [promptResult];
      for (const key of USAGE_CONTAINER_KEYS) {
        if (promptResult[key]) candidates.push(promptResult[key]);
      }
      const promptTokens = findFirst(candidates, PROMPT_TOKEN_KEYS);
      const completionTokens = findFirst(candidates, COMPLETION_TOKEN_KEYS);
      const totalTokens = findFirst(candidates, TOTAL_TOKEN_KEYS);
      if (promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined) {
        usageChunksFromResult++;
        console.log(`[usage-probe] Extension WOULD extract usage from session/prompt result:`);
        console.log(`[usage-probe]   promptTokens=${promptTokens}, completionTokens=${completionTokens}, totalTokens=${totalTokens}`);
      }
    }

    console.log(`[usage-probe] Usage chunks the extension would emit from session/update: ${usageChunksFromUpdates}`);
    console.log(`[usage-probe] Usage chunk the extension would emit from session/prompt result: ${usageChunksFromResult}`);

    const totalUsageChunks = usageChunksFromUpdates + usageChunksFromResult;
    console.log(`[usage-probe] Total usage chunks the extension would emit: ${totalUsageChunks}`);

    if (totalUsageChunks > 0) {
      console.log('[usage-probe] RESULT: Context usage WILL be populated in the extension UI');
    } else {
      console.log('[usage-probe] RESULT: Context usage WILL NOT be populated — extension will show 0% (no data state)');
      console.log('[usage-probe] REASON: CLI does not send any of the known token count keys');
    }

    // ── Phase 10: Summary and exit code ──────────────────────────
    console.log('\n[usage-probe] ═══════════════════════════════════════════');
    console.log('[usage-probe] SUMMARY');
    console.log('[usage-probe] ═══════════════════════════════════════════');
    console.log(`[usage-probe] session/update notifications: ${allUpdates.length}`);
    console.log(`[usage-probe] notifications with usage data: ${updatesWithUsage}`);
    console.log(`[usage-probe] usage found in session/prompt result: ${resultUsageHits.length > 0}`);
    console.log(`[usage-probe] extension would emit usage chunks: ${totalUsageChunks}`);
    console.log(`[usage-probe] context usage visible in UI: ${totalUsageChunks > 0}`);

    if (failures.length > 0) {
      console.error('\n[usage-probe] FAILURES:');
      for (const f of failures) {
        console.error(`[usage-probe]   - ${f}`);
      }
      testPassed = false;
    } else {
      console.log('\n[usage-probe] Probe completed — check results above to determine pipeline health');
    }

  } catch (err) {
    console.error(`[usage-probe] ERROR: ${err?.stack || err?.message || String(err)}`);
    testPassed = false;
  } finally {
    await gracefulTeardown(ws, child);
    const stderrTail = proc.getStderrTail();
    const stdoutTail = proc.getStdoutTail();
    if (stderrTail.trim()) {
      console.log(`\n[usage-probe] iflow stderr tail:\n${stderrTail.slice(-1500)}`);
    }
    if (stdoutTail.trim()) {
      console.log(`\n[usage-probe] iflow stdout tail:\n${stdoutTail.slice(-1500)}`);
    }
  }

  if (!testPassed) {
    process.exitCode = 1;
  }
}

/**
 * Find first numeric value matching any of the given keys in a list of candidate objects.
 */
function findFirst(candidates, keys) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    for (const key of keys) {
      const v = candidate[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        return Math.max(0, Math.round(v));
      }
    }
  }
  return undefined;
}

main().catch((err) => {
  console.error(`[usage-probe] fatal: ${err?.stack || err?.message || String(err)}`);
  process.exitCode = 1;
});
