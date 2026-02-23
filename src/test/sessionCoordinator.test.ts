import * as assert from 'assert';
import { SessionCoordinator } from '../acp/sessionCoordinator';
import { RuntimeConfigApplier } from '../acp/runtimeConfigApplier';
import { InteractionBridge } from '../acp/interactionBridge';
import { ConnectionSnapshot, RunOptions } from '../acp/types';

class FakeTransport {
  connected = false;
  connectCalls = 0;
  disconnectCalls = 0;
  onClose: ((error?: Error) => void) | null = null;

  async connect(): Promise<void> {
    this.connected = true;
    this.connectCalls += 1;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.disconnectCalls += 1;
  }

  triggerClose(error?: Error): void {
    this.connected = false;
    this.onClose?.(error);
  }

  async send(): Promise<void> {}

  async receive(): Promise<string> {
    return new Promise<string>(() => {
      // no-op in tests
    });
  }
}

class FakeProtocol {
  requests: Array<{ method: string; params?: unknown }> = [];
  serverHandlers = new Map<string, (...args: unknown[]) => unknown>();
  started = false;
  disposed = false;
  failOnMethod: string | null = null;

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });

    if (this.failOnMethod && method === this.failOnMethod) {
      throw new Error(`forced failure on ${method}`);
    }

    switch (method) {
      case 'initialize':
        return { isAuthenticated: false };
      case 'authenticate':
        return { ok: true };
      case 'session/new':
        return { sessionId: 'session-new-1' };
      case 'session/load':
        return { ok: true };
      case 'session/set_mode':
        return { ok: true };
      case 'session/set_model':
        return { ok: true };
      case 'session/set_think':
        return { ok: true };
      default:
        return { ok: true };
    }
  }

  onServerMethod(method: string, handler: (...args: unknown[]) => unknown): void {
    this.serverHandlers.set(method, handler);
  }

  onNotification(): void {}

  startReceiveLoop(): void {
    this.started = true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function baseRunOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    prompt: 'hello',
    attachedFiles: [],
    mode: 'default',
    think: false,
    model: 'GLM-4.7',
    cwd: '/tmp/workspace-a',
    ...overrides,
  };
}

suite('SessionCoordinator', () => {
  test('establishes connection and reaches ready state', async () => {
    const snapshots: Array<{ snapshot: ConnectionSnapshot; reason: string }> = [];
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => {},
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
      onConnectionStateChange: (snapshot, reason) => {
        snapshots.push({ snapshot, reason });
      },
    });

    await coordinator.ensureConnected(baseRunOptions());

    assert.strictEqual(coordinator.currentIsConnected, true);
    assert.strictEqual(coordinator.currentSessionId, 'session-new-1');
    assert.ok(snapshots.some((s) => s.snapshot.status === 'connecting'));
    assert.ok(snapshots.some((s) => s.snapshot.status === 'initializing'));
    assert.ok(snapshots.some((s) => s.snapshot.status === 'ready'));
  });

  test('reuses connection for same cwd and loads requested session', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => {},
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions({ cwd: '/tmp/workspace-a' }));
    const connectCallsAfterFirstRun = transport.connectCalls;

    await coordinator.ensureConnected(baseRunOptions({
      cwd: '/tmp/workspace-a',
      sessionId: 'session-loaded-1',
      mode: 'smart',
    }));

    assert.strictEqual(transport.connectCalls, connectCallsAfterFirstRun);
    assert.ok(protocol.requests.some((r) => r.method === 'session/load'));
    assert.strictEqual(coordinator.currentSessionId, 'session-loaded-1');
  });

  test('reconnects when cwd changes', async () => {
    const transportA = new FakeTransport();
    const transportB = new FakeTransport();
    const protocolA = new FakeProtocol();
    const protocolB = new FakeProtocol();
    let createTransportCalls = 0;

    const coordinator = new SessionCoordinator({
      createTransport: () => {
        createTransportCalls += 1;
        return createTransportCalls === 1 ? transportA as never : transportB as never;
      },
      createProtocol: () => (createTransportCalls === 1 ? protocolA : protocolB) as never,
      getProcessManager: () => ({
        hasProcess: true,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => {},
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await coordinator.ensureConnected(baseRunOptions({ cwd: '/tmp/workspace-a' }));
    await coordinator.ensureConnected(baseRunOptions({ cwd: '/tmp/workspace-b' }));

    assert.strictEqual(createTransportCalls, 2);
    assert.ok(transportA.disconnectCalls >= 1);
    assert.strictEqual(coordinator.currentCwd, '/tmp/workspace-b');
  });

  test('rolls back to disconnected on initialization failure', async () => {
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();
    protocol.failOnMethod = 'session/new';

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => {},
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
    });

    await assert.rejects(
      coordinator.ensureConnected(baseRunOptions()),
      /forced failure on session\/new/,
    );

    assert.strictEqual(coordinator.currentIsConnected, false);
    assert.strictEqual(coordinator.currentProtocol, null);
    assert.strictEqual(coordinator.currentSessionId, null);
    assert.strictEqual(coordinator.connectionSnapshot.status, 'disconnected');
  });

  test('publishes closed transition when transport closes', async () => {
    const reasons: string[] = [];
    const transport = new FakeTransport();
    const protocol = new FakeProtocol();

    const coordinator = new SessionCoordinator({
      createTransport: () => transport as never,
      createProtocol: () => protocol as never,
      getProcessManager: () => ({
        hasProcess: true,
        stopManagedProcess: () => {},
        resolveStartMode: async () => null,
        startManagedProcess: async () => {},
      }),
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      runtimeConfigApplier: new RuntimeConfigApplier(() => {}),
      interactionBridge: new InteractionBridge(() => {}, (p) => p, () => {}),
      log: () => {},
      onConnectionStateChange: (_snapshot, reason) => {
        reasons.push(reason);
      },
    });

    await coordinator.ensureConnected(baseRunOptions());
    transport.triggerClose(new Error('socket dropped'));

    assert.strictEqual(coordinator.currentIsConnected, false);
    assert.strictEqual(coordinator.currentSessionId, null);
    assert.strictEqual(coordinator.connectionSnapshot.status, 'disconnected');
    assert.ok(reasons.includes('closed'));
  });
});
