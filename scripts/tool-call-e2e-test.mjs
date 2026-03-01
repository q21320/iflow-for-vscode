#!/usr/bin/env node
/**
 * Tool Call E2E Test — Real CLI scenario
 *
 * Creates a temporary workspace folder, then asks the CLI to write a simple
 * Red Alert mini-game (HTML+JS). This guarantees tool_call/write_file usage.
 *
 * Flow:
 *   1. Create temp workspace dir
 *   2. Initialize + authenticate
 *   3. Create session with the temp dir as cwd
 *   4. Send prompt requesting a mini-game → triggers write_file tool calls
 *   5. Validate tool_call notifications, status transitions, permissions
 *   6. Verify no pending RPCs or stuck tools
 *   7. Cleanup
 *
 * Usage:
 *   IFLOW_REAL_CLI_TEST=1 node scripts/tool-call-e2e-test.mjs
 *
 * Environment variables:
 *   IFLOW_ACP_PORT               - ACP port (default: 8125)
 *   IFLOW_ACP_CONNECT_TIMEOUT_MS - WS connection timeout (default: 30000)
 *   IFLOW_ACP_PHASE_TIMEOUT_MS   - Per-phase timeout (default: 90000)
 *   IFLOW_ACP_DUMP_ALL           - Dump all session/update envelopes (default: 0)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  safeJson,
  sleep,
  spawnIflowProcess,
  connectWsWithRetry,
  createRpcHarness,
  gracefulTeardown,
  initializeAndAuthenticate,
  withPhaseTimeout,
} from './_acpProbeShared.mjs';

// ── Config ─────────────────────────────────────────────────────────

const port = Number(process.env.IFLOW_ACP_PORT || 8125);
const wsUrl = `ws://127.0.0.1:${port}/acp`;
const connectTimeoutMs = Number(process.env.IFLOW_ACP_CONNECT_TIMEOUT_MS || 30000);
const phaseTimeoutMs = Number(process.env.IFLOW_ACP_PHASE_TIMEOUT_MS || 90000);
const dumpAll = process.env.IFLOW_ACP_DUMP_ALL === '1';

const TOOL_PROMPT = `Create a simple "Red Alert" mini-game as a single index.html file.
Requirements:
- A canvas element for the game area
- Player unit (blue square) that moves with arrow keys
- 3 enemy units (red squares) that move randomly
- A score counter that increases when player touches enemies
- Basic collision detection
Keep it under 150 lines total. Write the file now using write_file tool.`;

// ── Validation ─────────────────────────────────────────────────────

class ValidationReport {
  constructor() {
    this.checks = [];
    this.startTime = Date.now();
  }

  must(id, description, condition) {
    this.checks.push({ id, description, severity: 'MUST', result: condition ? 'PASS' : 'FAIL' });
    return condition;
  }

  should(id, description, condition) {
    this.checks.push({ id, description, severity: 'SHOULD', result: condition ? 'PASS' : 'FAIL' });
    return condition;
  }

  print() {
    const durationMs = Date.now() - this.startTime;
    const passed = this.checks.filter((c) => c.result === 'PASS').length;
    const failed = this.checks.filter((c) => c.result === 'FAIL');
    const mustFailed = failed.filter((c) => c.severity === 'MUST');

    console.log('\n[tool-e2e] summary');
    console.log(`[tool-e2e] total checks: ${this.checks.length}`);
    console.log(`[tool-e2e] passed: ${passed}`);
    console.log(`[tool-e2e] failed: ${failed.length} (MUST: ${mustFailed.length})`);
    console.log(`[tool-e2e] duration: ${durationMs}ms`);

    for (const check of this.checks) {
      const icon = check.result === 'PASS' ? 'OK' : 'FAIL';
      console.log(`[tool-e2e]   [${icon}] ${check.id}: ${check.description} (${check.severity})`);
    }

    return mustFailed.length === 0;
  }
}

// ── Main flow ──────────────────────────────────────────────────────

async function main() {
  const report = new ValidationReport();
  const log = (msg) => console.log(`[tool-e2e] ${msg}`);

  // Create temporary workspace directory
  const tempDir = mkdtempSync(join(tmpdir(), 'iflow-tool-e2e-'));
  log(`temp workspace: ${tempDir}`);

  log(`starting iflow ACP on port ${port}`);
  const proc = spawnIflowProcess({ port, enableStream: true, cwd: tempDir });
  const { child } = proc;

  // Observers for raw session/update payloads (capture full update objects)
  const rawToolCalls = [];
  const rawToolCallUpdates = [];

  // Tool-specific observers
  const toolObservers = {
    permissionRequests: [],
    toolCallStatuses: new Map(), // toolCallId -> last status
  };

  let ws;
  try {
    // ── Phase 1: Connect ─────────────────────────────────────────
    ws = await withPhaseTimeout('ws-connect', async () => {
      return connectWsWithRetry(wsUrl, connectTimeoutMs);
    }, connectTimeoutMs + 5000);
    log(`connected ${wsUrl}`);

    const harness = createRpcHarness(ws, {
      dumpUpdates: dumpAll,
      onServerMethod: (method, _id, params) => {
        if (method === 'session/request_permission') {
          toolObservers.permissionRequests.push({
            toolName: params?.toolCall?.toolName,
            title: params?.toolCall?.title,
            timestamp: Date.now(),
          });
          log(`permission request: ${params?.toolCall?.toolName} - ${params?.toolCall?.title}`);
          return undefined; // fall through to default auto-approve
        }

        if (method === '_iflow/plan/exit') {
          return { approved: false };
        }

        return undefined;
      },
      onNotification: (method, params) => {
        if (method !== 'session/update') return;
        const update = params?.update || params || {};
        const su = update.sessionUpdate;

        if (su === 'tool_call') {
          rawToolCalls.push(update);
          if (update.toolCallId) {
            toolObservers.toolCallStatuses.set(update.toolCallId, update.status || 'pending');
          }
        }
        if (su === 'tool_call_update') {
          rawToolCallUpdates.push(update);
          if (update.toolCallId && update.status) {
            toolObservers.toolCallStatuses.set(update.toolCallId, update.status);
          }
        }
      },
    });
    const { request, observers, getPendingCount } = harness;

    // ── Phase 2: Initialize ──────────────────────────────────────
    let initOk = false;
    try {
      await withPhaseTimeout('initialize', async () => {
        await initializeAndAuthenticate(harness, log);
      }, phaseTimeoutMs);
      initOk = true;
    } catch (err) {
      log(`initialize failed: ${err.message}`);
    }
    report.must('T-001', 'Initialize succeeds', initOk);

    if (!initOk) {
      report.print();
      throw new Error('Cannot proceed without successful initialization');
    }

    // ── Phase 3: Create session ──────────────────────────────────
    let sessionId = null;
    try {
      const sessionNew = await withPhaseTimeout('session-new', async () => {
        return request('session/new', {
          cwd: tempDir,
          mcpServers: [],
          settings: {
            permission_mode: 'default',
            add_dirs: [tempDir],
          },
        });
      }, phaseTimeoutMs);

      sessionId = sessionNew?.sessionId ?? null;
      log(`session/new => sessionId=${sessionId}`);
    } catch (err) {
      log(`session/new failed: ${err.message}`);
    }
    report.must('T-002', 'session/new returns sessionId', sessionId !== null);

    if (!sessionId) {
      report.print();
      throw new Error('Cannot proceed without sessionId');
    }

    await request('session/set_mode', { sessionId, modeId: 'default' });

    // ── Phase 4: Send tool prompt ────────────────────────────────
    let promptOk = false;
    try {
      const promptResult = await withPhaseTimeout('tool-prompt', async () => {
        return request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: TOOL_PROMPT }],
        });
      }, phaseTimeoutMs);
      promptOk = true;
      log(`session/prompt completed => ${safeJson(promptResult, 500)}`);
    } catch (err) {
      log(`tool prompt failed: ${err.message}`);
    }
    report.must('T-003', 'Tool prompt completes without error', promptOk);

    // Wait for trailing notifications
    await sleep(2000);

    // ── Phase 5: Validate tool call notifications ─────────────────
    const totalToolNotifications = rawToolCalls.length + rawToolCallUpdates.length;
    log(`tool_call notifications: ${rawToolCalls.length}`);
    log(`tool_call_update notifications: ${rawToolCallUpdates.length}`);
    log(`total tool notifications: ${totalToolNotifications}`);

    report.must('T-004', 'Received at least one tool_call notification', totalToolNotifications > 0);

    // T-005: Check for write_file in tool updates
    const hasWriteFile = rawToolCalls.some((u) => u.toolName === 'write_file')
      || rawToolCallUpdates.some((u) => u.toolName === 'write_file');
    log(`write_file present: ${hasWriteFile}`);
    report.should('T-005', 'write_file appears in tool_call updates', hasWriteFile);

    // T-006: Check for permission request
    const hasPermission = toolObservers.permissionRequests.length > 0
      || observers.serverMethodCalls.some((c) => c.method === 'session/request_permission');
    log(`permission requests: ${toolObservers.permissionRequests.length}`);
    report.should('T-006', 'session/request_permission received', hasPermission);

    // T-007: Verify tool statuses include completed or failed (not stuck in pending)
    const allStatuses = [...toolObservers.toolCallStatuses.values()];
    log(`tracked tool call statuses: ${safeJson(Object.fromEntries(toolObservers.toolCallStatuses))}`);
    const hasTerminalStatus = allStatuses.some((s) => s === 'completed' || s === 'failed');
    const hasStuckPending = allStatuses.length > 0 && allStatuses.every((s) => s === 'pending');
    log(`has terminal status: ${hasTerminalStatus}, stuck pending: ${hasStuckPending}`);
    report.must('T-007', 'Tool states include completed/failed (not stuck in pending)',
      totalToolNotifications === 0 || (hasTerminalStatus && !hasStuckPending));

    // ── Phase 6: Final validation ────────────────────────────────
    const pendingRpc = getPendingCount();
    log(`pending RPC count at end: ${pendingRpc}`);
    report.must('T-008', 'No unresolved pending RPC at exit', pendingRpc === 0);

    // Print update type distribution
    const byType = new Map();
    for (const n of observers.sessionUpdates) {
      byType.set(n.sessionUpdate, (byType.get(n.sessionUpdate) || 0) + 1);
    }
    log('session/update distribution:');
    for (const [type, count] of byType.entries()) {
      log(`  ${type}: ${count}`);
    }

    // Print permission request details
    if (toolObservers.permissionRequests.length > 0) {
      log('permission request details:');
      for (const req of toolObservers.permissionRequests) {
        log(`  tool: ${req.toolName} title: ${req.title}`);
      }
    }

    // Print server method calls
    log('server method call sequence:');
    for (const call of observers.serverMethodCalls) {
      log(`  ${call.method} (id=${call.id})`);
    }

  } finally {
    // ── Phase 7: Cleanup ─────────────────────────────────────────
    let cleanupOk = false;
    try {
      await gracefulTeardown(ws, child);
      cleanupOk = true;
    } catch {
      // Best effort
    }
    report.must('T-009', 'Process cleanup successful', cleanupOk);

    // Cleanup temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
      log(`cleaned up temp dir: ${tempDir}`);
    } catch {
      log(`warning: failed to clean temp dir: ${tempDir}`);
    }

    const stderrTail = proc.getStderrTail();
    const stdoutTail = proc.getStdoutTail();
    if (stderrTail.trim()) {
      log(`iflow stderr tail:\n${stderrTail.slice(-800)}`);
    }
    if (stdoutTail.trim()) {
      log(`iflow stdout tail:\n${stdoutTail.slice(-800)}`);
    }
  }

  // Final report
  const allMustPassed = report.print();
  if (!allMustPassed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[tool-e2e] fatal: ${err?.stack || err?.message || String(err)}`);
  process.exitCode = 1;
});
