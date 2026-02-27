import * as assert from 'assert';
import { VisualUpdateScheduler } from '../shared/visualUpdateScheduler';

interface SchedulerHarness {
  scheduler: VisualUpdateScheduler;
  scheduleCalls: number;
  streamingCalls: number;
  pendingCalls: number;
  flushFrame: () => void;
}

function createHarness(): SchedulerHarness {
  let nextToken = 1;
  const frames = new Map<number, () => void>();
  let scheduleCalls = 0;
  let streamingCalls = 0;
  let pendingCalls = 0;

  const scheduler = new VisualUpdateScheduler(
    (run) => {
      const token = nextToken++;
      frames.set(token, run);
      scheduleCalls += 1;
      return token;
    },
    (token) => {
      frames.delete(token);
    },
    {
      onStreamingUpdate: () => {
        streamingCalls += 1;
      },
      onPendingIndicatorUpdate: () => {
        pendingCalls += 1;
      },
    },
  );

  return {
    scheduler,
    get scheduleCalls() {
      return scheduleCalls;
    },
    get streamingCalls() {
      return streamingCalls;
    },
    get pendingCalls() {
      return pendingCalls;
    },
    flushFrame: () => {
      const pending = Array.from(frames.values());
      frames.clear();
      for (const run of pending) {
        run();
      }
    },
  };
}

suite('VisualUpdateScheduler', () => {
  test('coalesces repeated streaming updates into one frame callback', () => {
    const harness = createHarness();

    harness.scheduler.scheduleStreamingUpdate();
    harness.scheduler.scheduleStreamingUpdate();
    harness.scheduler.scheduleStreamingUpdate();

    assert.strictEqual(harness.scheduleCalls, 1);
    assert.strictEqual(harness.streamingCalls, 0);

    harness.flushFrame();

    assert.strictEqual(harness.streamingCalls, 1);
    assert.strictEqual(harness.pendingCalls, 0);
  });

  test('gives streaming update priority over pending indicator in same frame', () => {
    const harness = createHarness();

    harness.scheduler.schedulePendingIndicatorUpdate();
    harness.scheduler.scheduleStreamingUpdate();

    assert.strictEqual(harness.scheduleCalls, 1);

    harness.flushFrame();

    assert.strictEqual(harness.streamingCalls, 1);
    assert.strictEqual(harness.pendingCalls, 0);
  });

  test('coalesces repeated pending indicator updates into one callback', () => {
    const harness = createHarness();

    harness.scheduler.schedulePendingIndicatorUpdate();
    harness.scheduler.schedulePendingIndicatorUpdate();

    assert.strictEqual(harness.scheduleCalls, 1);

    harness.flushFrame();

    assert.strictEqual(harness.pendingCalls, 1);
    assert.strictEqual(harness.streamingCalls, 0);
  });

  test('cancelAll drops queued work and allows future scheduling', () => {
    const harness = createHarness();

    harness.scheduler.scheduleStreamingUpdate();
    harness.scheduler.cancelAll();
    harness.flushFrame();

    assert.strictEqual(harness.streamingCalls, 0);
    assert.strictEqual(harness.pendingCalls, 0);

    harness.scheduler.schedulePendingIndicatorUpdate();
    harness.flushFrame();
    assert.strictEqual(harness.pendingCalls, 1);
  });
});
