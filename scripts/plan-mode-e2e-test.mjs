#!/usr/bin/env node
/**
 * Plan Mode E2E Test
 *
 * Connects to a real iflow CLI and exercises the complete plan mode flow:
 *   1. Create a plan-mode session
 *   2. Send a plan prompt
 *   3. Collect plan output from session/update notifications
 *   4. Handle _iflow/plan/exit approval
 *   5. Switch to execution mode
 *   6. Send execution prompt and collect output
 *   7. Validate all 10 checkpoints
 *
 * Usage:
 *   IFLOW_REAL_CLI_TEST=1 node scripts/plan-mode-e2e-test.mjs
 *
 * Environment variables:
 *   IFLOW_ACP_PORT            - ACP port (default: 8124)
 *   IFLOW_ACP_CONNECT_TIMEOUT_MS - WS connection timeout (default: 30000)
 *   IFLOW_ACP_PHASE_TIMEOUT_MS   - Per-phase timeout (default: 60000)
 *   IFLOW_PLAN_PROMPT         - Custom plan prompt
 *   IFLOW_EXEC_MODE           - Execution mode: 'smart' or 'default' (default: smart)
 *   IFLOW_ACP_DUMP_ALL        - Dump all session/update envelopes (default: 0)
 */
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

const port = Number(process.env.IFLOW_ACP_PORT || 8124);
const wsUrl = `ws://127.0.0.1:${port}/acp`;
const cwd = process.cwd();
const connectTimeoutMs = Number(process.env.IFLOW_ACP_CONNECT_TIMEOUT_MS || 30000);
const phaseTimeoutMs = Number(process.env.IFLOW_ACP_PHASE_TIMEOUT_MS || 60000);
const dumpAll = process.env.IFLOW_ACP_DUMP_ALL === '1';
const execMode = process.env.IFLOW_EXEC_MODE || 'smart';

const PLAN_PROMPT = process.env.IFLOW_PLAN_PROMPT
  || 'Reply with a simple 3-step plan to create a hello world Node.js program. Number each step. Do not execute the plan.';

const EXEC_PROMPT = '<system-reminder>\nPlan mode has been deactivated. The user approved the plan. You are now in execution mode. You may now freely use all tools including write_file, edit_file, run_shell_command, and other modification tools. Please proceed with the implementation.\n</system-reminder>';

const PLAN_MODE_INSTRUCTIONS = `
Plan mode is active.
You must stay in planning-only mode.
Do not execute modifying actions (no file writes/edits, no state-changing shell commands, no commits).
Use read-only analysis and provide a concrete implementation plan, then wait for user approval.
`.trim();

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

    console.log('\n[plan-e2e] summary');
    console.log(`[plan-e2e] total checks: ${this.checks.length}`);
    console.log(`[plan-e2e] passed: ${passed}`);
    console.log(`[plan-e2e] failed: ${failed.length} (MUST: ${mustFailed.length})`);
    console.log(`[plan-e2e] duration: ${durationMs}ms`);

    for (const check of this.checks) {
      const icon = check.result === 'PASS' ? 'OK' : 'FAIL';
      console.log(`[plan-e2e]   [${icon}] ${check.id}: ${check.description} (${check.severity})`);
    }

    return mustFailed.length === 0;
  }
}

// ── Main flow ──────────────────────────────────────────────────────

async function main() {
  const report = new ValidationReport();
  const log = (msg) => console.log(`[plan-e2e] ${msg}`);

  log(`starting iflow ACP on port ${port}`);
  const proc = spawnIflowProcess({ port, enableStream: true, cwd });
  const { child } = proc;

  // Plan-specific observers
  const planObservers = {
    planExitRequests: [],
    permissionRequests: [],
    execTextContent: [],
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
        if (method === '_iflow/plan/exit') {
          planObservers.planExitRequests.push({
            params,
            timestamp: Date.now(),
          });
          log(`received _iflow/plan/exit (plan length: ${params?.plan?.length ?? 0})`);
          // Approve the plan
          return { approved: true };
        }

        if (method === 'session/request_permission') {
          planObservers.permissionRequests.push({
            toolName: params?.toolCall?.toolName,
            timestamp: Date.now(),
          });
          return undefined; // fall through to default auto-approve
        }

        return undefined; // fall through to default
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
    report.must('V-001', 'initialize succeeds', initOk);

    if (!initOk) {
      report.print();
      throw new Error('Cannot proceed without successful initialization');
    }

    // ── Phase 3: Create plan session ─────────────────────────────
    let sessionId = null;
    try {
      const sessionNew = await withPhaseTimeout('session-new', async () => {
        return request('session/new', {
          cwd,
          mcpServers: [],
          settings: {
            permission_mode: 'plan',
            append_system_prompt: PLAN_MODE_INSTRUCTIONS,
            add_dirs: [cwd],
          },
        });
      }, phaseTimeoutMs);

      sessionId = sessionNew?.sessionId ?? null;
      log(`session/new => sessionId=${sessionId}`);
    } catch (err) {
      log(`session/new failed: ${err.message}`);
    }
    report.must('V-002', 'session/new returns sessionId', sessionId !== null);

    if (!sessionId) {
      report.print();
      throw new Error('Cannot proceed without sessionId');
    }

    // Set plan mode explicitly
    await request('session/set_mode', { sessionId, modeId: 'plan' });
    log('session/set_mode => plan');

    // ── Phase 4: Send plan prompt ────────────────────────────────
    let planPromptOk = false;
    let planResult = null;
    try {
      planResult = await withPhaseTimeout('plan-prompt', async () => {
        return request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: PLAN_PROMPT }],
        });
      }, phaseTimeoutMs);
      planPromptOk = true;
      log(`session/prompt (plan) completed => ${safeJson(planResult, 500)}`);
    } catch (err) {
      log(`plan prompt failed: ${err.message}`);
    }
    report.must('V-003', 'plan prompt completes without error', planPromptOk);

    // Wait for any trailing notifications
    await sleep(2000);

    // ── Phase 5: Validate plan output ────────────────────────────
    const updateCount = observers.sessionUpdates.length;
    log(`session/update count: ${updateCount}`);
    report.must('V-004', 'received session/update notifications (>= 1)', updateCount >= 1);

    // Check plan content: must have either plan/exit text or session/update text chunks
    const hasTextUpdates = observers.sessionUpdates.some(
      (u) => u.sessionUpdate === 'text' || u.sessionUpdate === 'agent_message',
    );
    const hasPlanExitText = planObservers.planExitRequests.some(
      (r) => typeof r.params?.plan === 'string' && r.params.plan.length > 0,
    );
    const hasPlanContent = hasTextUpdates || hasPlanExitText;
    report.must('V-005', 'plan content is non-empty (text updates or plan/exit text)', hasPlanContent);

    // Check for _iflow/plan/exit (legacy bridge)
    const planExitCount = planObservers.planExitRequests.length;
    log(`_iflow/plan/exit requests: ${planExitCount}`);
    report.must('V-006', '_iflow/plan/exit received (legacy bridge)', planExitCount >= 1);

    // ── Phase 6: Switch to execution mode ────────────────────────
    let execPromptOk = false;
    let execResult = null;

    try {
      await request('session/set_mode', { sessionId, modeId: execMode });
      log(`session/set_mode => ${execMode}`);

      // Clear update count before execution
      const preExecUpdateCount = observers.sessionUpdates.length;

      execResult = await withPhaseTimeout('exec-prompt', async () => {
        return request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: EXEC_PROMPT }],
        });
      }, phaseTimeoutMs);
      execPromptOk = true;
      log(`session/prompt (exec) completed => ${safeJson(execResult, 500)}`);

      // Wait for trailing execution notifications
      await sleep(2000);

      // Count execution-phase updates
      const postExecUpdateCount = observers.sessionUpdates.length;
      const execUpdateCount = postExecUpdateCount - preExecUpdateCount;
      log(`execution-phase session/update count: ${execUpdateCount}`);

      report.must('V-008', 'execution output received', execUpdateCount >= 1);
    } catch (err) {
      log(`execution phase failed: ${err.message}`);
    }
    report.must('V-007', 'execution prompt completes without error', execPromptOk);

    // ── Phase 7: Final validation ────────────────────────────────
    const pendingRpc = getPendingCount();
    log(`pending RPC count at end: ${pendingRpc}`);
    report.must('V-009', 'no unresolved pending RPC at exit', pendingRpc === 0);

    // Print update type distribution
    const byType = new Map();
    for (const n of observers.sessionUpdates) {
      byType.set(n.sessionUpdate, (byType.get(n.sessionUpdate) || 0) + 1);
    }
    log('session/update distribution:');
    for (const [type, count] of byType.entries()) {
      log(`  ${type}: ${count}`);
    }

    // Print permission requests
    if (planObservers.permissionRequests.length > 0) {
      log(`permission requests: ${planObservers.permissionRequests.length}`);
      for (const req of planObservers.permissionRequests) {
        log(`  tool: ${req.toolName}`);
      }
    }

    // Print server method call sequence
    log('server method call sequence:');
    for (const call of observers.serverMethodCalls) {
      log(`  ${call.method} (id=${call.id})`);
    }

  } finally {
    // ── Phase 8: Cleanup ─────────────────────────────────────────
    let cleanupOk = false;
    try {
      await gracefulTeardown(ws, child);
      cleanupOk = true;
    } catch {
      // Best effort
    }
    report.must('V-010', 'process cleanup successful', cleanupOk);

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
  console.error(`[plan-e2e] fatal: ${err?.stack || err?.message || String(err)}`);
  process.exitCode = 1;
});
