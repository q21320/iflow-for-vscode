import * as assert from 'assert';
import { InteractionBridge } from '../acp/interactionBridge';

class FakeProtocol {
  private handlers = new Map<string, (id: number, params: unknown) => Promise<unknown>>();

  onServerMethod(method: string, handler: (id: number, params: unknown) => Promise<unknown>): void {
    this.handlers.set(method, handler);
  }

  async invoke(method: string, id: number, params: unknown): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new Error(`Missing handler for ${method}`);
    }
    return handler(id, params);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('InteractionBridge', () => {
  test('permission interaction resolves selected option', async () => {
    const chunks: string[] = [];
    const bridge = new InteractionBridge(
      (chunk) => chunks.push(chunk.chunkType),
      (rawPath) => rawPath,
      () => {},
      { interactionTimeoutMs: 200 },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const permissionPromise = protocol.invoke('session/request_permission', 100, {
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'allow-always', kind: 'allow_always' },
      ],
      toolCall: {
        toolName: 'write_file',
        title: 'Write file',
        kind: 'edit',
      },
    });

    await bridge.approveToolCall(100, 'allow');

    const resolved = await permissionPromise;
    assert.deepStrictEqual(resolved, {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    assert.ok(chunks.includes('tool_confirmation'));
    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0);
  });

  test('question interaction times out and is cleaned up', async () => {
    const warnings: string[] = [];
    const bridge = new InteractionBridge(
      (chunk) => {
        if (chunk.chunkType === 'warning') {
          warnings.push(chunk.message);
        }
      },
      (rawPath) => rawPath,
      () => {},
      { interactionTimeoutMs: 20 },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const questionPromise = protocol.invoke('_iflow/user/questions', 101, {
      questions: [
        {
          question: 'Proceed?',
          header: 'Confirm',
          options: [{ label: 'Yes', description: 'continue' }],
          multiSelect: false,
        },
      ],
    });

    await wait(60);
    const resolved = await questionPromise;

    assert.deepStrictEqual(resolved, { answers: {} });
    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0);
    assert.ok(warnings.some((m) => m.includes('timed out')));
  });

  test('clearPendingInteractions cancels pending plan and clears timers', async () => {
    const bridge = new InteractionBridge(
      () => {},
      (rawPath) => rawPath,
      () => {},
      { interactionTimeoutMs: 5000 },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const planPromise = protocol.invoke('_iflow/plan/exit', 102, { plan: 'test plan' });
    bridge.clearPendingInteractions('dispose');

    const resolved = await planPromise;
    assert.deepStrictEqual(resolved, { approved: false });
    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0);
  });

  test('duplicate response after consume is idempotent', async () => {
    const bridge = new InteractionBridge(
      () => {},
      (rawPath) => rawPath,
      () => {},
      { interactionTimeoutMs: 5000 },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const permissionPromise = protocol.invoke('session/request_permission', 103, {
      options: [{ optionId: 'allow-once', kind: 'allow_once' }],
      toolCall: { toolName: 'read_file' },
    });

    await bridge.rejectToolCall(103);
    await bridge.approveToolCall(103, 'allow');

    const resolved = await permissionPromise;
    assert.deepStrictEqual(resolved, { outcome: { outcome: 'cancelled' } });
    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0);
  });
});
