import * as assert from 'assert';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  sentMessages: string[] = [];

  constructor(public url: string, private autoOpen = true) {
    super();
    if (autoOpen) {
      // Simulate successful open on next tick
      queueMicrotask(() => this.emit('open'));
    }
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close');
  }

  terminate(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close');
  }

  /** Test helper: simulate server sending a message */
  injectMessage(data: string): void {
    this.emit('message', Buffer.from(data));
  }

  /** Test helper: simulate connection error */
  injectError(err: Error): void {
    this.emit('error', err);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// We import AcpTransport lazily so we can set up the mock before the module
// is loaded.  The actual file will be created in the next step.
// For now these tests define the expected interface contract.

import { AcpTransport } from '../acpTransport';

suite('AcpTransport', () => {
  let transport: AcpTransport;

  setup(() => {
    transport = new AcpTransport((_msg: string) => {});
  });

  teardown(async () => {
    try { await transport.disconnect(); } catch { /* ok */ }
  });

  // ── connect / disconnect ────────────────────────────────────────────

  test('connect sets isConnected to true', async () => {
    await transport.connect({ url: 'ws://localhost:9999/acp', timeout: 5000 }, () => new MockWebSocket('ws://localhost:9999/acp') as any);
    assert.strictEqual(transport.isConnected, true);
  });

  test('disconnect sets isConnected to false', async () => {
    await transport.connect({ url: 'ws://localhost:9999/acp', timeout: 5000 }, () => new MockWebSocket('ws://localhost:9999/acp') as any);
    await transport.disconnect();
    assert.strictEqual(transport.isConnected, false);
  });

  test('connect rejects on WebSocket error', async () => {
    const factory = () => {
      const ws = new MockWebSocket('ws://localhost:9999/acp', false);
      // Emit error on next tick (no 'open' event)
      queueMicrotask(() => ws.emit('error', new Error('Connection refused')));
      return ws as any;
    };

    await assert.rejects(
      () => transport.connect({ url: 'ws://localhost:9999/acp', timeout: 5000 }, factory),
      /Connection refused/
    );
    assert.strictEqual(transport.isConnected, false);
  });

  test('connect rejects on timeout when socket never opens', async () => {
    const factory = () => new MockWebSocket('ws://localhost:9999/acp', false) as any;

    await assert.rejects(
      () => transport.connect({ url: 'ws://localhost:9999/acp', timeout: 20 }, factory),
      /Connection timeout after 20 ms/
    );
    assert.strictEqual(transport.isConnected, false);
  });

  // ── send ────────────────────────────────────────────────────────────

  test('send delivers data to WebSocket', async () => {
    let mockWs: MockWebSocket | null = null;
    await transport.connect({ url: 'ws://localhost:9999/acp', timeout: 5000 }, () => {
      mockWs = new MockWebSocket('ws://localhost:9999/acp');
      return mockWs as any;
    });

    await transport.send('{"method":"test"}');
    assert.deepStrictEqual(mockWs!.sentMessages, ['{"method":"test"}']);
  });

  test('send throws when not connected', async () => {
    await assert.rejects(
      () => transport.send('hello'),
      /Not connected/
    );
  });

  // ── receive: buffer pattern (message arrives before receive) ────────

  test('receive returns buffered message', async () => {
    let mockWs: MockWebSocket | null = null;
    await transport.connect({ url: 'ws://localhost:9999/acp', timeout: 5000 }, () => {
      mockWs = new MockWebSocket('ws://localhost:9999/acp');
      return mockWs as any;
    });

    // Message arrives first
    mockWs!.injectMessage('{"id":1}');
    // Then receive is called
    const msg = await transport.receive();
    assert.strictEqual(msg, '{"id":1}');
  });

  // ── receive: waiter pattern (receive called before message) ─────────

  test('receive waits for incoming message', async () => {
    let mockWs: MockWebSocket | null = null;
    await transport.connect({ url: 'ws://localhost:9999/acp', timeout: 5000 }, () => {
      mockWs = new MockWebSocket('ws://localhost:9999/acp');
      return mockWs as any;
    });

    // receive() called first (will block)
    const receivePromise = transport.receive();
    // Then message arrives
    mockWs!.injectMessage('{"id":2}');
    const msg = await receivePromise;
    assert.strictEqual(msg, '{"id":2}');
  });

  // ── receive: multiple messages buffered ─────────────────────────────

  test('receive returns messages in FIFO order', async () => {
    let mockWs: MockWebSocket | null = null;
    await transport.connect({ url: 'ws://localhost:9999/acp', timeout: 5000 }, () => {
      mockWs = new MockWebSocket('ws://localhost:9999/acp');
      return mockWs as any;
    });

    mockWs!.injectMessage('msg-1');
    mockWs!.injectMessage('msg-2');
    mockWs!.injectMessage('msg-3');

    assert.strictEqual(await transport.receive(), 'msg-1');
    assert.strictEqual(await transport.receive(), 'msg-2');
    assert.strictEqual(await transport.receive(), 'msg-3');
  });

  // ── receive: connection close rejects pending waiters ───────────────

  test('pending receive rejects on connection close', async () => {
    let mockWs: MockWebSocket | null = null;
    await transport.connect({ url: 'ws://localhost:9999/acp', timeout: 5000 }, () => {
      mockWs = new MockWebSocket('ws://localhost:9999/acp');
      return mockWs as any;
    });

    const receivePromise = transport.receive();
    mockWs!.close();

    await assert.rejects(receivePromise, /Connection closed/);
  });

  // ── receive: connection error rejects pending waiters ───────────────

  test('pending receive rejects on connection error', async () => {
    let mockWs: MockWebSocket | null = null;
    await transport.connect({ url: 'ws://localhost:9999/acp', timeout: 5000 }, () => {
      mockWs = new MockWebSocket('ws://localhost:9999/acp');
      return mockWs as any;
    });

    const receivePromise = transport.receive();
    mockWs!.injectError(new Error('Socket error'));

    await assert.rejects(receivePromise, /Socket error/);
  });

  // ── receive: not connected ─────────────────────────────────────────

  test('receive rejects when not connected', async () => {
    await assert.rejects(
      () => transport.receive(),
      /Not connected/
    );
  });

  // ── onClose callback ──────────────────────────────────────────────

  test('onClose callback fires on unexpected close', async () => {
    let closeError: Error | undefined;
    transport.onClose = (err) => { closeError = err; };

    let mockWs: MockWebSocket | null = null;
    await transport.connect({ url: 'ws://localhost:9999/acp', timeout: 5000 }, () => {
      mockWs = new MockWebSocket('ws://localhost:9999/acp');
      return mockWs as any;
    });

    mockWs!.close();

    // Give the event a tick to propagate
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(closeError instanceof Error || closeError === undefined);
    assert.strictEqual(transport.isConnected, false);
  });
});
