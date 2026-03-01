import * as assert from 'assert';
import { InactivityGuard } from '../acp/inactivityGuard';

function createGuard(
  timeoutMs: number,
  onTimeout: (tool: { name: string; title: string } | null) => void,
  checkIntervalMs = 10,
): InactivityGuard {
  return new InactivityGuard(timeoutMs, onTimeout, () => {}, checkIntervalMs);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('InactivityGuard', () => {
  let guard: InactivityGuard;

  teardown(() => {
    guard?.stop();
  });

  test('does not trigger before timeout', async () => {
    let triggered = false;
    guard = createGuard(200, () => { triggered = true; }, 10);
    guard.start(() => true);

    await wait(50);
    assert.strictEqual(triggered, false);
    assert.strictEqual(guard.didTrigger, false);
  });

  test('triggers after timeout when running', async () => {
    let triggered = false;
    guard = createGuard(30, () => { triggered = true; }, 10);
    guard.start(() => true);

    await wait(80);
    assert.strictEqual(triggered, true);
    assert.strictEqual(guard.didTrigger, true);
  });

  test('markActivity resets the timer', async () => {
    let triggered = false;
    guard = createGuard(50, () => { triggered = true; }, 10);
    guard.start(() => true);

    await wait(30);
    guard.markActivity({});
    await wait(30);
    guard.markActivity({});
    await wait(30);

    assert.strictEqual(triggered, false);
    assert.strictEqual(guard.didTrigger, false);
  });

  test('does not trigger when not running', async () => {
    let triggered = false;
    guard = createGuard(20, () => { triggered = true; }, 10);
    guard.start(() => false);

    await wait(60);
    assert.strictEqual(triggered, false);
  });

  test('disabled when timeoutMs is 0', async () => {
    let triggered = false;
    guard = createGuard(0, () => { triggered = true; }, 10);
    guard.start(() => true);

    await wait(40);
    assert.strictEqual(triggered, false);
  });

  test('markActivity tracks lastInProgressTool', () => {
    guard = createGuard(5000, () => {}, 100);

    guard.markActivity({
      sessionUpdate: 'tool_call_update',
      status: 'in_progress',
      toolName: 'write_file',
      title: 'Writing index.html',
    });

    assert.deepStrictEqual(guard.lastTool, {
      name: 'write_file',
      title: 'Writing index.html',
    });
  });

  test('onTimeout receives lastInProgressTool', async () => {
    let receivedTool: { name: string; title: string } | null = null;
    guard = createGuard(20, (tool) => { receivedTool = tool; }, 10);

    guard.markActivity({
      sessionUpdate: 'tool_call_update',
      status: 'in_progress',
      toolName: 'todo_write',
      title: 'Todo',
    });
    guard.start(() => true);

    await wait(60);
    assert.deepStrictEqual(receivedTool, {
      name: 'todo_write',
      title: 'Todo',
    });
  });

  test('tracks pending tool_call as last tool after todo updates', () => {
    guard = createGuard(5000, () => {}, 100);

    guard.markActivity({
      sessionUpdate: 'tool_call_update',
      status: 'in_progress',
      toolName: 'todo_write',
      title: 'Todo',
    });
    guard.markActivity({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      toolName: 'todo_write',
      title: 'Todo',
    });
    guard.markActivity({
      sessionUpdate: 'tool_call',
      status: 'pending',
      toolName: 'write_file',
      title: 'Write File',
    });

    assert.deepStrictEqual(guard.lastTool, {
      name: 'write_file',
      title: 'Write File',
    });
  });

  test('stop clears interval', async () => {
    let triggered = false;
    guard = createGuard(20, () => { triggered = true; }, 10);
    guard.start(() => true);

    guard.stop();
    await wait(60);
    assert.strictEqual(triggered, false);
  });

  test('triggers only once', async () => {
    let count = 0;
    guard = createGuard(20, () => { count += 1; }, 10);
    guard.start(() => true);

    await wait(100);
    guard.stop();
    assert.strictEqual(count, 1);
  });

  test('markActivity with non-object is safe', () => {
    guard = createGuard(5000, () => {}, 100);

    assert.doesNotThrow(() => guard.markActivity(null));
    assert.doesNotThrow(() => guard.markActivity(42));
    assert.doesNotThrow(() => guard.markActivity('string'));
    assert.doesNotThrow(() => guard.markActivity(undefined));
    assert.strictEqual(guard.lastTool, null);
  });
});
