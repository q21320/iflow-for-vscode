import * as assert from 'assert';
import { formatStreamStatusText, reduceStreamStatus, StreamStatusSnapshot } from '../streamStatusUtils';

suite('streamStatusUtils', () => {
  test('formatStreamStatusText always returns Flowing text', () => {
    assert.strictEqual(
      formatStreamStatusText({ phase: 'preparing', elapsedMs: 120 }),
      'Flowing...',
    );
    assert.strictEqual(
      formatStreamStatusText({ phase: 'connecting', elapsedMs: 330 }),
      'Flowing...',
    );
    assert.strictEqual(
      formatStreamStatusText({ phase: 'waiting_first_chunk', elapsedMs: 1800 }),
      'Flowing...',
    );
    assert.strictEqual(formatStreamStatusText(null), 'Flowing...');
  });

  test('reduceStreamStatus clears status on stream chunk/end/error and when streaming stops', () => {
    const initial: StreamStatusSnapshot = { phase: 'waiting_first_chunk', elapsedMs: 1000 };

    assert.strictEqual(reduceStreamStatus(initial, { type: 'streamChunk' }), null);
    assert.strictEqual(reduceStreamStatus(initial, { type: 'streamEnd' }), null);
    assert.strictEqual(reduceStreamStatus(initial, { type: 'streamError' }), null);
    assert.strictEqual(
      reduceStreamStatus(initial, { type: 'stateUpdated', isStreaming: false }),
      null,
    );
  });

  test('reduceStreamStatus updates status and keeps it during streaming state updates', () => {
    const next = reduceStreamStatus(null, {
      type: 'streamStatus',
      phase: 'connecting',
      elapsedMs: 250,
    });
    assert.deepStrictEqual(next, { phase: 'connecting', elapsedMs: 250 });
    assert.deepStrictEqual(
      reduceStreamStatus(next, { type: 'stateUpdated', isStreaming: true }),
      next,
    );
  });
});
