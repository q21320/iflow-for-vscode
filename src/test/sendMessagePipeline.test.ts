import * as assert from 'assert';
import { SendMessagePipeline } from '../webview/sendMessagePipeline';
import { ConversationStore } from '../store';
import { PlanApprovalCoordinator } from '../webview/planApprovalCoordinator';
import { PlanModeOrchestrator } from '../webview/planModeOrchestrator';
import { ExtensionMessage, StreamChunk } from '../protocol';
import { RunOptions } from '../acp/types';

class FakeMemento {
  private value: unknown;

  constructor(initialValue: unknown) {
    this.value = initialValue;
  }

  get<T>(key: string): T | undefined {
    if (key !== 'iflow.conversations') {
      return undefined;
    }
    return this.value as T;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (key === 'iflow.conversations') {
      this.value = value;
    }
    return Promise.resolve();
  }
}

class FakeClient {
  runCalls: RunOptions[] = [];

  async run(
    options: RunOptions,
    onChunk: (chunk: StreamChunk) => void,
    onEnd: () => void,
    _onError: (error: string) => void,
  ): Promise<string | undefined> {
    this.runCalls.push(options);
    if (options.prompt.includes('emit-plan')) {
      onChunk({
        chunkType: 'plan_approval',
        requestId: 55,
        plan: 'mock plan',
      });
    }
    onEnd();
    return `session-${this.runCalls.length}`;
  }
}

suite('SendMessagePipeline', () => {
  test('short-circuits when CLI is unavailable', async () => {
    const store = new ConversationStore(
      new FakeMemento({ currentId: null, conversations: [] }) as unknown as import('vscode').Memento,
      () => {},
    );
    store.newConversation();

    const client = new FakeClient();
    const messages: ExtensionMessage[] = [];
    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      authService: { ensureValidToken: async () => false } as unknown as import('../authService').AuthService,
      postMessage: (message) => messages.push(message),
      checkCliForSend: async () => ({ available: false, error: 'cli down' }),
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'hello',
      attachedFiles: [],
      silent: false,
    });

    assert.strictEqual(client.runCalls.length, 0);
    assert.ok(messages.some((m) => m.type === 'streamError'));
  });

  test('replays approved plan via queue without recursive send', async () => {
    const store = new ConversationStore(
      new FakeMemento({ currentId: null, conversations: [] }) as unknown as import('vscode').Memento,
      () => {},
    );
    store.newConversation();
    store.setMode('plan');

    const client = new FakeClient();
    const messages: ExtensionMessage[] = [];
    const planApprovalCoordinator = new PlanApprovalCoordinator(new PlanModeOrchestrator());

    const pipeline = new SendMessagePipeline({
      store,
      client: client as unknown as import('../acpClient').AcpClient,
      authService: { ensureValidToken: async () => true } as unknown as import('../authService').AuthService,
      postMessage: (message) => {
        messages.push(message);
        if (message.type === 'streamChunk'
          && message.chunk.chunkType === 'plan_approval'
          && message.chunk.requestId === -1) {
          planApprovalCoordinator.registerSyntheticApproval('smart');
        }
      },
      checkCliForSend: async () => ({ available: true, error: '' }),
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      planApprovalCoordinator,
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'plan this work',
      attachedFiles: [],
      silent: false,
    });

    assert.strictEqual(client.runCalls.length, 2);
    assert.strictEqual(client.runCalls[0].mode, 'plan');
    assert.strictEqual(client.runCalls[1].mode, 'smart');
    assert.ok(client.runCalls[1].prompt.includes('system-reminder'));
    assert.ok(messages.some((m) => m.type === 'streamChunk' && m.chunk.chunkType === 'plan_approval'));
  });

  test('normalizes empty runtime errors before emitting streamError', async () => {
    const store = new ConversationStore(
      new FakeMemento({ currentId: null, conversations: [] }) as unknown as import('vscode').Memento,
      () => {},
    );
    store.newConversation();

    const messages: ExtensionMessage[] = [];
    const failingClient = {
      run: async (
        _options: RunOptions,
        _onChunk: (chunk: StreamChunk) => void,
        _onEnd: () => void,
        onError: (error: string) => void,
      ) => {
        onError('   ');
        return undefined;
      },
    };

    const pipeline = new SendMessagePipeline({
      store,
      client: failingClient as unknown as import('../acpClient').AcpClient,
      authService: { ensureValidToken: async () => true } as unknown as import('../authService').AuthService,
      postMessage: (message) => messages.push(message),
      checkCliForSend: async () => ({ available: true, error: '' }),
      markCliUnavailable: () => {},
      resolveWorkspaceFolder: () => '/tmp/workspace',
      getAllWorkspaceFolderPaths: () => ['/tmp/workspace'],
      getWorkspaceFileList: async () => [],
      planApprovalCoordinator: new PlanApprovalCoordinator(new PlanModeOrchestrator()),
      debug: () => {},
      setSessionId: (sessionId) => store.setSessionId(sessionId),
    });

    await pipeline.execute({
      content: 'trigger error',
      attachedFiles: [],
      silent: false,
    });

    const streamError = messages.find((m) => m.type === 'streamError') as Extract<ExtensionMessage, { type: 'streamError' }> | undefined;
    assert.ok(streamError);
    assert.strictEqual(streamError?.error, 'Unknown error');

    const conversation = store.getCurrentConversation();
    assert.ok(conversation);
    const lastMessage = conversation?.messages[conversation.messages.length - 1];
    assert.ok(lastMessage && lastMessage.role === 'assistant');
    const errorBlock = lastMessage?.blocks.find((b) => b.type === 'error') as Extract<NonNullable<typeof lastMessage>['blocks'][number], { type: 'error' }> | undefined;
    assert.ok(errorBlock);
    assert.strictEqual(errorBlock?.message, 'Unknown error');
  });
});
