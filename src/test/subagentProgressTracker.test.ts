import * as assert from 'assert';
import { formatSubagentProgressText, SubagentProgressTracker } from '../shared/subagentProgressTracker';

suite('SubagentProgressTracker', () => {
  test('starts tracking only when task tool_start indicates subagent launch', () => {
    const tracker = new SubagentProgressTracker();

    const unchanged = tracker.onChunk({
      chunkType: 'tool_start',
      name: 'task',
      input: {},
      label: 'task',
      toolCallId: 'task-1',
    }, 1000);

    assert.strictEqual(unchanged, false);
    assert.strictEqual(tracker.active, null);

    const changed = tracker.onChunk({
      chunkType: 'tool_start',
      name: 'task',
      input: { subagent_type: 'frontend-tester' },
      label: 'Launch agent(frontend-tester): Test page',
      toolCallId: 'task-1',
    }, 1200);

    assert.strictEqual(changed, true);
    assert.deepStrictEqual(tracker.active, {
      taskToolCallId: 'task-1',
      startedAtMs: 1200,
      lastStep: 'Launch agent(frontend-tester): Test page',
      lastStepAtMs: 1200,
    });
  });

  test('updates last step while subagent is active and clears when task ends', () => {
    const tracker = new SubagentProgressTracker();

    tracker.onChunk({
      chunkType: 'tool_start',
      name: 'task',
      input: { subagent_type: 'frontend-tester' },
      label: 'Launch agent(frontend-tester): Test page',
      toolCallId: 'task-1',
    }, 2000);

    const nestedChanged = tracker.onChunk({
      chunkType: 'tool_start',
      name: 'browser_click',
      input: { element: 'Start Game' },
      toolCallId: 'tool-1',
    }, 2400);

    assert.strictEqual(nestedChanged, true);
    assert.strictEqual(tracker.active?.lastStep, 'browser_click · Start Game');
    assert.strictEqual(tracker.active?.lastStepAtMs, 2400);

    const nestedEndChanged = tracker.onChunk({
      chunkType: 'tool_end',
      status: 'completed',
      toolCallId: 'tool-1',
    }, 2600);

    assert.strictEqual(nestedEndChanged, true);
    assert.strictEqual(tracker.active?.lastStep, 'browser_click · Start Game (done)');

    const ended = tracker.onChunk({
      chunkType: 'tool_end',
      status: 'completed',
      toolCallId: 'task-1',
    }, 3000);

    assert.strictEqual(ended, true);
    assert.strictEqual(tracker.active, null);
  });

  test('formatSubagentProgressText includes elapsed seconds and last step', () => {
    const text = formatSubagentProgressText({
      taskToolCallId: 'task-9',
      startedAtMs: 1000,
      lastStep: 'browser_navigate',
      lastStepAtMs: 1500,
    }, 6400);

    assert.strictEqual(text, 'Sub-agent running 5s · No new steps 4s · Last step: browser_navigate');
  });

  test('formatSubagentProgressText omits idle segment when step is updated now', () => {
    const text = formatSubagentProgressText({
      taskToolCallId: 'task-10',
      startedAtMs: 2000,
      lastStep: 'browser_click · Start Game',
      lastStepAtMs: 7000,
    }, 7000);

    assert.strictEqual(text, 'Sub-agent running 5s · Last step: browser_click · Start Game');
  });
});
