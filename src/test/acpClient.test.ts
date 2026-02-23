import * as assert from 'assert';
import { AcpClient } from '../acpClient';

class FakeTransport {
  connected = false;
  onClose: ((error?: Error) => void) | null = null;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async send(): Promise<void> {}

  async receive(): Promise<string> {
    return new Promise<string>(() => {}); // blocks forever in tests
  }
}

class FakeProtocol {
  requests: Array<{ method: string; params: unknown }> = [];
  serverHandlers = new Map<string, Function>();
  notificationHandlers = new Map<string, Function>();
  started = false;
  disposed = false;

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });

    switch (method) {
      case 'initialize':
        return { protocolVersion: 1, isAuthenticated: false };
      case 'authenticate':
        return { methodId: 'iflow' };
      case 'session/new':
        return { sessionId: 'test-session-123' };
      case 'session/load':
        return {};
      case 'session/set_mode':
        return { success: true, currentModeId: (params as any)?.modeId };
      case 'session/set_model':
        return { success: true, currentModelId: (params as any)?.modelId };
      case 'session/set_think':
        return { success: true, currentThinkEnabled: Boolean((params as any)?.thinkEnabled) };
      case 'session/prompt':
        this.simulateUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello!' },
        });
        return { stopReason: 'end_turn' };
      case 'session/cancel':
        return {};
      default:
        return {};
    }
  }

  async sendResult(_id: number, _result: unknown): Promise<void> {}
  async sendError(_id: number, _code: number, _message: string): Promise<void> {}

  onServerMethod(method: string, handler: Function): void {
    this.serverHandlers.set(method, handler);
  }

  onNotification(method: string, handler: Function): void {
    this.notificationHandlers.set(method, handler);
  }

  startReceiveLoop(): void {
    this.started = true;
  }

  stopReceiveLoop(): void {}

  dispose(): void {
    this.disposed = true;
  }

  simulateUpdate(update: Record<string, unknown>): void {
    const handler = this.notificationHandlers.get('session/update');
    if (handler) {
      handler({ sessionId: 'test-session-123', update });
    }
  }

  async simulateServerMethod(method: string, id: number, params: unknown): Promise<unknown> {
    const handler = this.serverHandlers.get(method);
    if (!handler) {
      throw new Error(`No handler for ${method}`);
    }
    return await handler(id, params);
  }
}

suite('AcpClient', () => {
  let client: AcpClient;
  let fakeTransport: FakeTransport;
  let fakeProtocol: FakeProtocol;

  setup(() => {
    client = new AcpClient();
    fakeTransport = new FakeTransport();
    fakeProtocol = new FakeProtocol();

    // Inject fakes
    (client as any)._createTransport = () => fakeTransport;
    (client as any)._createProtocol = (_t: unknown) => fakeProtocol;

    // Skip settings file I/O in tests
    (client as any).updateIFlowCliModel = () => {};
    (client as any).updateIFlowCliApiConfig = () => {};

    // Avoid spawning real processes in unit tests.
    (client as any).processManager = {
      hasProcess: true,
      stopManagedProcess: () => {},
      clearAutoDetectCache: () => {},
      resolveStartMode: async () => null,
      startManagedProcess: async () => {},
    };
  });

  teardown(async () => {
    try {
      await client.dispose();
    } catch {
      // no-op
    }
  });

  test('run sends ACP-compliant initialize/prompt payloads and streams chunks', async () => {
    let ended = false;
    let error: string | null = null;
    const chunks: any[] = [];

    const sessionId = await client.run(
      {
        prompt: 'hello',
        attachedFiles: [],
        mode: 'smart',
        think: false,
        model: 'GLM-4.7' as any,
        cwd: '/tmp/workspace',
        fileAllowedDirs: ['/tmp/workspace'],
      },
      (chunk) => chunks.push(chunk),
      () => { ended = true; },
      (err) => { error = err; },
    );

    assert.strictEqual(error, null);
    assert.strictEqual(ended, true);
    assert.strictEqual(sessionId, 'test-session-123');
    assert.ok(chunks.some(c => c.chunkType === 'text'));

    const initialize = fakeProtocol.requests.find(r => r.method === 'initialize');
    assert.ok(initialize);
    assert.deepStrictEqual(initialize?.params, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });

    const newSession = fakeProtocol.requests.find(r => r.method === 'session/new');
    assert.ok(newSession);
    assert.deepStrictEqual((newSession?.params as any)?.settings, {
      permission_mode: 'smart',
      add_dirs: ['/tmp/workspace'],
    });

    const prompt = fakeProtocol.requests.find(r => r.method === 'session/prompt');
    assert.ok(prompt);
    assert.strictEqual((prompt?.params as any)?.sessionId, 'test-session-123');
    assert.ok(Array.isArray((prompt?.params as any)?.prompt));
    assert.strictEqual((prompt?.params as any)?.prompt[0]?.type, 'text');

    assert.ok(fakeProtocol.requests.some(r => r.method === 'session/set_mode'));
    assert.ok(fakeProtocol.requests.some(r => r.method === 'session/set_model'));
    assert.ok(fakeProtocol.requests.some(r => r.method === 'session/set_think'));
  });

  test('run emits usage chunk when session/prompt result includes usage metadata', async () => {
    const chunks: any[] = [];

    const originalSendRequest = fakeProtocol.sendRequest.bind(fakeProtocol);
    fakeProtocol.sendRequest = async (method: string, params?: unknown) => {
      if (method === 'session/prompt') {
        fakeProtocol.simulateUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello!' },
        });
        return {
          stopReason: 'end_turn',
          usageMetadata: {
            promptTokenCount: 321,
            candidatesTokenCount: 12,
            totalTokenCount: 333,
          },
        };
      }
      return originalSendRequest(method, params);
    };

    await client.run(
      {
        prompt: 'hello',
        attachedFiles: [],
        mode: 'default',
        think: false,
        model: 'GLM-4.7' as any,
      },
      (chunk) => chunks.push(chunk),
      () => {},
      () => {},
    );

    const usage = chunks.find((c) => c.chunkType === 'usage');
    assert.ok(usage);
    assert.strictEqual(usage?.promptTokens, 321);
    assert.strictEqual(usage?.completionTokens, 12);
    assert.strictEqual(usage?.totalTokens, 333);
  });

  test('run emits usage chunk when usage is on session/update envelope', async () => {
    const chunks: any[] = [];

    const originalSendRequest = fakeProtocol.sendRequest.bind(fakeProtocol);
    fakeProtocol.sendRequest = async (method: string, params?: unknown) => {
      if (method === 'session/prompt') {
        const handler = fakeProtocol.notificationHandlers.get('session/update');
        if (handler) {
          handler({
            sessionId: 'test-session-123',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello!' },
            },
            usageMetadata: {
              promptTokenCount: 777,
              candidatesTokenCount: 21,
              totalTokenCount: 798,
            },
          });
        }
        return { stopReason: 'end_turn' };
      }
      return originalSendRequest(method, params);
    };

    await client.run(
      {
        prompt: 'hello',
        attachedFiles: [],
        mode: 'default',
        think: false,
        model: 'GLM-4.7' as any,
      },
      (chunk) => chunks.push(chunk),
      () => {},
      () => {},
    );

    const usage = chunks.find((c) => c.chunkType === 'usage');
    assert.ok(usage);
    assert.strictEqual(usage?.promptTokens, 777);
    assert.strictEqual(usage?.completionTokens, 21);
    assert.strictEqual(usage?.totalTokens, 798);
  });

  test('run sends thinkConfig when thinking is enabled', async () => {
    await client.run(
      {
        prompt: 'hello',
        attachedFiles: [],
        mode: 'default',
        think: true,
        model: 'GLM-4.7' as any,
      },
      () => {},
      () => {},
      () => {},
    );

    const thinkRequest = fakeProtocol.requests.find(r => r.method === 'session/set_think');
    assert.ok(thinkRequest);
    assert.strictEqual((thinkRequest?.params as any)?.thinkEnabled, true);
    assert.strictEqual((thinkRequest?.params as any)?.thinkConfig, 'think');
  });

  test('run succeeds without explicit fileAllowedDirs by falling back to cwd', async () => {
    let ended = false;
    let error: string | null = null;

    await client.run(
      {
        prompt: 'fallback dirs',
        attachedFiles: [],
        mode: 'default',
        think: false,
        model: 'GLM-4.7' as any,
        cwd: '/tmp/workspace',
      },
      () => {},
      () => {
        ended = true;
      },
      (err) => {
        error = err;
      },
    );

    assert.strictEqual(error, null);
    assert.strictEqual(ended, true);
  });

  test('permission server method emits tool_confirmation and uses server optionId', async () => {
    const chunks: any[] = [];

    const originalSendRequest = fakeProtocol.sendRequest.bind(fakeProtocol);
    fakeProtocol.sendRequest = async (method: string, params?: unknown) => {
      if (method === 'session/prompt') {
        const waitPermission = fakeProtocol.simulateServerMethod('session/request_permission', 77, {
          options: [
            { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'proceed_always', kind: 'allow_always', name: 'Always allow' },
          ],
          toolCall: {
            title: 'Write file',
            toolName: 'write_file',
            kind: 'edit',
          },
        });

        setTimeout(() => {
          void client.approveToolCall(77, 'allow');
        }, 0);

        await waitPermission;
      }

      return originalSendRequest(method, params);
    };

    await client.run(
      {
        prompt: 'hello',
        attachedFiles: [],
        mode: 'default',
        think: false,
        model: 'GLM-4.7' as any,
      },
      (chunk) => chunks.push(chunk),
      () => {},
      () => {},
    );

    const confirmation = chunks.find(c => c.chunkType === 'tool_confirmation');
    assert.ok(confirmation);
    assert.strictEqual(confirmation.requestId, 77);
    assert.strictEqual(confirmation.toolName, 'write_file');
    assert.strictEqual(confirmation.confirmationType, 'edit');
  });

  test('approveToolCall maps allow/alwaysAllow to server-provided option IDs', async () => {
    let allowValue: unknown = null;
    let alwaysValue: unknown = null;

    (client as any).pendingPermissions = new Map();
    (client as any).pendingPermissions.set(42, {
      kind: 'permission',
      resolve: (value: unknown) => {
        allowValue = value;
      },
      options: [
        { optionId: 'allow-once-id', kind: 'allow_once' },
        { optionId: 'allow-always-id', kind: 'allow_always' },
      ],
    });

    await client.approveToolCall(42, 'allow');
    assert.deepStrictEqual(allowValue, {
      outcome: { outcome: 'selected', optionId: 'allow-once-id' },
    });

    (client as any).pendingPermissions.set(43, {
      kind: 'permission',
      resolve: (value: unknown) => {
        alwaysValue = value;
      },
      options: [
        { optionId: 'allow-once-id', kind: 'allow_once' },
        { optionId: 'allow-always-id', kind: 'allow_always' },
      ],
    });

    await client.approveToolCall(43, 'alwaysAllow');
    assert.deepStrictEqual(alwaysValue, {
      outcome: { outcome: 'selected', optionId: 'allow-always-id' },
    });
  });

  test('rejectToolCall resolves pending permission with cancelled outcome', async () => {
    let resolvedValue: unknown = null;

    (client as any).pendingPermissions = new Map();
    (client as any).pendingPermissions.set(44, {
      kind: 'permission',
      resolve: (value: unknown) => {
        resolvedValue = value;
      },
      options: [],
    });

    await client.rejectToolCall(44);
    assert.deepStrictEqual(resolvedValue, { outcome: { outcome: 'cancelled' } });
  });

  test('answerQuestions resolves pending question request', async () => {
    let resolvedValue: unknown = null;

    (client as any).pendingPermissions = new Map();
    (client as any).pendingPermissions.set(45, {
      kind: 'question',
      resolve: (value: unknown) => {
        resolvedValue = value;
      },
    });

    await client.answerQuestions(45, { q1: 'yes' });
    assert.deepStrictEqual(resolvedValue, { answers: { q1: 'yes' } });
  });

  test('approvePlan resolves pending plan request', async () => {
    let resolvedValue: unknown = null;

    (client as any).pendingPermissions = new Map();
    (client as any).pendingPermissions.set(46, {
      kind: 'plan',
      resolve: (value: unknown) => {
        resolvedValue = value;
      },
    });

    await client.approvePlan(46, true);
    assert.deepStrictEqual(resolvedValue, { approved: true });
  });

  test('cancel sends session/cancel with sessionId', async () => {
    (client as any).protocol = fakeProtocol;
    (client as any).isConnected = true;
    (client as any).sessionId = 'test-session-123';

    await client.cancel();

    const cancelReq = fakeProtocol.requests.find(r => r.method === 'session/cancel');
    assert.ok(cancelReq);
    assert.deepStrictEqual(cancelReq?.params, { sessionId: 'test-session-123' });
  });
});
