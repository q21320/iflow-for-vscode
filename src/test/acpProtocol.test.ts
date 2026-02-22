import * as assert from 'assert';
import { AcpProtocol } from '../acpProtocol';

// ---------------------------------------------------------------------------
// Fake AcpTransport for testing AcpProtocol in isolation
// ---------------------------------------------------------------------------

class FakeTransport {
  sent: string[] = [];
  failNextSend: Error | null = null;
  private receiveResolvers: Array<(msg: string) => void> = [];
  private receiveRejecters: Array<(err: Error) => void> = [];
  private messageBuffer: string[] = [];

  get isConnected(): boolean { return true; }

  async send(data: string): Promise<void> {
    if (this.failNextSend) {
      const err = this.failNextSend;
      this.failNextSend = null;
      throw err;
    }
    this.sent.push(data);
  }

  async receive(): Promise<string> {
    if (this.messageBuffer.length > 0) {
      return this.messageBuffer.shift()!;
    }
    return new Promise<string>((resolve, reject) => {
      this.receiveResolvers.push(resolve);
      this.receiveRejecters.push(reject);
    });
  }

  /** Test helper: deliver a message as if the server sent it. */
  deliver(data: string): void {
    const resolver = this.receiveResolvers.shift();
    if (resolver) {
      this.receiveRejecters.shift();
      resolver(data);
    } else {
      this.messageBuffer.push(data);
    }
  }

  /** Test helper: simulate connection close. */
  breakConnection(): void {
    while (this.receiveRejecters.length > 0) {
      this.receiveResolvers.shift();
      this.receiveRejecters.shift()!(new Error('Connection closed'));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lastSent(transport: FakeTransport): Record<string, unknown> {
  const raw = transport.sent[transport.sent.length - 1];
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('AcpProtocol', () => {
  let transport: FakeTransport;
  let protocol: AcpProtocol;

  setup(() => {
    transport = new FakeTransport();
    protocol = new AcpProtocol(transport as any, (_msg: string) => {});
    protocol.startReceiveLoop();
  });

  teardown(() => {
    protocol.dispose();
  });

  // ── sendRequest / response correlation ────────────────────────────

  test('sendRequest sends JSON-RPC request and resolves on response', async () => {
    const resultPromise = protocol.sendRequest('initialize', { version: '1.0' });

    // Get the sent request to find its ID
    const sent = lastSent(transport);
    assert.strictEqual(sent.jsonrpc, '2.0');
    assert.strictEqual(sent.method, 'initialize');
    assert.deepStrictEqual(sent.params, { version: '1.0' });
    assert.ok(typeof sent.id === 'number');

    // Deliver matching response
    transport.deliver(JSON.stringify({
      jsonrpc: '2.0',
      id: sent.id,
      result: { protocolVersion: '2024-11-05' },
    }));

    const result = await resultPromise;
    assert.deepStrictEqual(result, { protocolVersion: '2024-11-05' });
  });

  test('sendRequest rejects on JSON-RPC error response', async () => {
    const resultPromise = protocol.sendRequest('bad_method');

    const sent = lastSent(transport);
    transport.deliver(JSON.stringify({
      jsonrpc: '2.0',
      id: sent.id,
      error: { code: -32601, message: 'Method not found' },
    }));

    await assert.rejects(resultPromise, /Method not found/);
  });

  test('sendRequest cleans pending request when transport.send fails', async () => {
    transport.failNextSend = new Error('send failed');
    await assert.rejects(
      () => protocol.sendRequest('initialize'),
      /send failed/,
    );
    assert.strictEqual((protocol as any).pendingRequests.size, 0);
  });

  test('concurrent requests are correlated by ID', async () => {
    const p1 = protocol.sendRequest('method_a');
    const p2 = protocol.sendRequest('method_b');

    const sent1 = JSON.parse(transport.sent[0]);
    const sent2 = JSON.parse(transport.sent[1]);

    // IDs should be different
    assert.notStrictEqual(sent1.id, sent2.id);

    // Respond to second request first (out of order)
    transport.deliver(JSON.stringify({
      jsonrpc: '2.0', id: sent2.id, result: 'result_b',
    }));
    transport.deliver(JSON.stringify({
      jsonrpc: '2.0', id: sent1.id, result: 'result_a',
    }));

    assert.strictEqual(await p1, 'result_a');
    assert.strictEqual(await p2, 'result_b');
  });

  // ── Server method handler ─────────────────────────────────────────

  test('server method handler dispatches and sends result', async () => {
    protocol.onServerMethod('_iflow/user/questions', async (_id, params) => {
      const p = params as { questions: string[] };
      return { answers: p.questions.map(() => 'yes') };
    });

    // Simulate server sending a request
    transport.deliver(JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: '_iflow/user/questions',
      params: { questions: ['q1', 'q2'] },
    }));

    // Give the async handler time to complete
    await new Promise(r => setTimeout(r, 50));

    // Protocol should have sent a result back
    const response = JSON.parse(transport.sent[transport.sent.length - 1]);
    assert.strictEqual(response.id, 42);
    assert.deepStrictEqual(response.result, { answers: ['yes', 'yes'] });
  });

  test('server method handler sends error on handler exception', async () => {
    protocol.onServerMethod('failing_method', async () => {
      throw new Error('Handler failed');
    });

    transport.deliver(JSON.stringify({
      jsonrpc: '2.0', id: 99, method: 'failing_method', params: {},
    }));

    await new Promise(r => setTimeout(r, 50));

    const response = JSON.parse(transport.sent[transport.sent.length - 1]);
    assert.strictEqual(response.id, 99);
    assert.ok(response.error);
    assert.strictEqual(response.error.code, -32603);
    assert.ok(response.error.message.includes('Handler failed'));
  });

  // ── Notification handler ──────────────────────────────────────────

  test('notification handler dispatches without sending response', async () => {
    let receivedParams: unknown = null;

    protocol.onNotification('session/update', (params) => {
      receivedParams = params;
    });

    transport.deliver(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { type: 'assistant', chunk: { text: 'hello' } },
    }));

    await new Promise(r => setTimeout(r, 50));

    assert.deepStrictEqual(receivedParams, {
      type: 'assistant',
      chunk: { text: 'hello' },
    });

    // No response should have been sent (notifications don't get replies)
    assert.strictEqual(transport.sent.length, 0);
  });

  // ── sendResult / sendError ────────────────────────────────────────

  test('sendResult sends JSON-RPC response', async () => {
    await protocol.sendResult(7, { approved: true });

    const sent = lastSent(transport);
    assert.strictEqual(sent.jsonrpc, '2.0');
    assert.strictEqual(sent.id, 7);
    assert.deepStrictEqual(sent.result, { approved: true });
  });

  test('sendError sends JSON-RPC error', async () => {
    await protocol.sendError(8, -32601, 'Method not found');

    const sent = lastSent(transport);
    assert.strictEqual(sent.jsonrpc, '2.0');
    assert.strictEqual(sent.id, 8);
    assert.deepStrictEqual(sent.error, { code: -32601, message: 'Method not found' });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  test('unregistered server method sends -32601 error', async () => {
    transport.deliver(JSON.stringify({
      jsonrpc: '2.0', id: 50, method: 'unknown_method', params: {},
    }));

    await new Promise(r => setTimeout(r, 50));

    const response = JSON.parse(transport.sent[transport.sent.length - 1]);
    assert.strictEqual(response.id, 50);
    assert.strictEqual(response.error.code, -32601);
  });

  test('unregistered notification is silently ignored', async () => {
    const sentBefore = transport.sent.length;

    transport.deliver(JSON.stringify({
      jsonrpc: '2.0', method: 'unknown_notification', params: {},
    }));

    await new Promise(r => setTimeout(r, 50));

    // No response sent
    assert.strictEqual(transport.sent.length, sentBefore);
  });
});
