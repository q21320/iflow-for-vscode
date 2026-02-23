import * as assert from 'assert';
import { routeWebviewMessage } from '../webview/messageRouter';

suite('messageRouter', () => {
  test('routes known message to handler', async () => {
    let called = false;
    const handled = await routeWebviewMessage(
      { type: 'ready' },
      {
        ready: () => {
          called = true;
        },
      },
    );

    assert.strictEqual(handled, true);
    assert.strictEqual(called, true);
  });

  test('reports unknown message via callback', async () => {
    const unknown: string[] = [];
    const handled = await routeWebviewMessage(
      { type: 'ready' },
      {},
      (messageType) => unknown.push(messageType),
    );

    assert.strictEqual(handled, false);
    assert.deepStrictEqual(unknown, ['ready']);
  });
});
