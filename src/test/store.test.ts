import * as assert from 'assert';
import { ConversationStore } from '../store';
import { ConversationState, ModelType, MODELS } from '../protocol';

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

  snapshot(): unknown {
    return this.value;
  }
}

suite('ConversationStore', () => {
  test('loads saved conversation and preserves mode and model', () => {
    const memento = new FakeMemento({
      currentId: 'c1',
      conversations: [
        {
          id: 'c1',
          title: 'legacy',
          messages: [],
          mode: 'smart',
          think: false,
          model: 'GLM-4.7',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    });

    const store = new ConversationStore(memento as unknown as import('vscode').Memento, () => {});
    const conversation = store.getCurrentConversation();

    assert.ok(conversation);
    assert.strictEqual(conversation?.mode, 'smart');
    assert.strictEqual(conversation?.model, 'GLM-4.7');
  });

  test('new conversation gets default model and mode', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    const store = new ConversationStore(memento as unknown as import('vscode').Memento, () => {});
    const conversation = store.newConversation();

    assert.strictEqual(conversation.model, MODELS[0]);
    assert.strictEqual(conversation.mode, 'default');
    assert.strictEqual(conversation.think, false);
  });

  test('setModel updates current conversation model', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    const store = new ConversationStore(memento as unknown as import('vscode').Memento, () => {});
    store.newConversation();

    const newModel: ModelType = 'DeepSeek-V3.2';
    store.setModel(newModel);

    const current = store.getCurrentConversation();
    assert.ok(current);
    assert.strictEqual(current?.model, 'DeepSeek-V3.2');
  });

  test('appendToAssistantMessage uses immutable updates and preserves previous snapshot', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    const store = new ConversationStore(memento as unknown as import('vscode').Memento, () => {});
    store.newConversation();
    store.startAssistantMessage();

    const beforeConversation = store.getCurrentConversation();
    assert.ok(beforeConversation);
    const beforeMessage = beforeConversation!.messages[beforeConversation!.messages.length - 1];
    assert.strictEqual(beforeMessage.content, '');
    assert.strictEqual(beforeMessage.blocks.length, 0);

    store.appendToAssistantMessage({ chunkType: 'text', content: 'hello' });

    const afterConversation = store.getCurrentConversation();
    assert.ok(afterConversation);
    const afterMessage = afterConversation!.messages[afterConversation!.messages.length - 1];

    assert.notStrictEqual(afterConversation, beforeConversation);
    assert.notStrictEqual(afterMessage, beforeMessage);
    assert.strictEqual(afterMessage.content, 'hello');
    assert.strictEqual(beforeMessage.content, '');
    assert.strictEqual(afterMessage.blocks.length, 1);
    assert.strictEqual(beforeMessage.blocks.length, 0);
  });

  test('appendToAssistantMessage usage chunk updates context usage without mutating message blocks', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    const store = new ConversationStore(memento as unknown as import('vscode').Memento, () => {});
    store.newConversation();
    store.startAssistantMessage();

    const before = store.getCurrentConversation();
    assert.ok(before);
    const beforeMessage = before!.messages[before!.messages.length - 1];
    assert.strictEqual(beforeMessage.blocks.length, 0);

    store.appendToAssistantMessage({
      chunkType: 'usage',
      promptTokens: 5000,
      completionTokens: 250,
      totalTokens: 5250,
    });

    const after = store.getCurrentConversation();
    assert.ok(after);
    const afterMessage = after!.messages[after!.messages.length - 1];
    assert.strictEqual(afterMessage.blocks.length, 0);

    const state = store.getState();
    assert.ok(state.contextUsage);
    assert.strictEqual(state.contextUsage?.usedTokens, 5000);
    assert.strictEqual(state.contextUsage?.totalTokens, 200000);
  });

  test('appendToAssistantMessage supports silent updates when notify=false', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    let notifyCount = 0;
    const store = new ConversationStore(
      memento as unknown as import('vscode').Memento,
      () => { notifyCount += 1; },
    );
    store.newConversation();
    store.startAssistantMessage();
    notifyCount = 0;

    store.appendToAssistantMessage({ chunkType: 'text', content: 'silent' }, { notify: false });

    assert.strictEqual(notifyCount, 0);
    const current = store.getCurrentConversation();
    const lastMessage = current?.messages[current.messages.length - 1];
    assert.strictEqual(lastMessage?.content, 'silent');
  });

  test('publishState emits current snapshot once', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    let notifyCount = 0;
    let lastState: ConversationState | null = null;
    const store = new ConversationStore(
      memento as unknown as import('vscode').Memento,
      (state) => {
        notifyCount += 1;
        lastState = state;
      },
    );
    store.newConversation();
    notifyCount = 0;
    lastState = null;

    store.publishState();

    assert.strictEqual(notifyCount, 1);
    assert.ok(lastState);
    const emittedState = lastState as ConversationState;
    assert.strictEqual(emittedState.currentConversationId, store.getCurrentConversation()?.id ?? null);
  });

  test('batchUpdate emits a single state change notification', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    let notifyCount = 0;
    const store = new ConversationStore(
      memento as unknown as import('vscode').Memento,
      () => { notifyCount += 1; }
    );

    store.batchUpdate(() => {
      store.setMode('smart');
      store.setThink(true);
      store.setModel('GLM-5');
    });

    assert.strictEqual(notifyCount, 1);
    const current = store.getCurrentConversation();
    assert.ok(current);
    assert.strictEqual(current?.mode, 'smart');
    assert.strictEqual(current?.think, true);
    assert.strictEqual(current?.model, 'GLM-5');
  });

  test('batchUpdate supports nested calls and emits once', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    let notifyCount = 0;
    const store = new ConversationStore(
      memento as unknown as import('vscode').Memento,
      () => { notifyCount += 1; }
    );

    store.batchUpdate(() => {
      store.setMode('smart');
      store.batchUpdate(() => {
        store.setThink(true);
      });
      store.setModel('GLM-5');
    });

    assert.strictEqual(notifyCount, 1);
    const current = store.getCurrentConversation();
    assert.ok(current);
    assert.strictEqual(current?.mode, 'smart');
    assert.strictEqual(current?.think, true);
    assert.strictEqual(current?.model, 'GLM-5');
  });

  test('deleteConversation reselects first remaining conversation when deleting active', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    const store = new ConversationStore(memento as unknown as import('vscode').Memento, () => {});
    const first = store.newConversation();
    const second = store.newConversation();
    store.switchConversation(first.id);

    store.deleteConversation(first.id);

    const current = store.getCurrentConversation();
    assert.ok(current);
    assert.strictEqual(current?.id, second.id);
  });

  test('clearCurrentConversation resets messages title and session id', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    const store = new ConversationStore(memento as unknown as import('vscode').Memento, () => {});
    store.newConversation();
    store.addUserMessage('hello world', []);
    store.setSessionId('session-123');

    store.clearCurrentConversation();
    const current = store.getCurrentConversation();
    assert.ok(current);
    assert.strictEqual(current?.messages.length, 0);
    assert.strictEqual(current?.title, 'New Conversation');
    assert.strictEqual(current?.sessionId, undefined);
  });

  test('save persists conversation state into memento', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    const store = new ConversationStore(memento as unknown as import('vscode').Memento, () => {});
    const conversation = store.newConversation();
    store.switchConversation(conversation.id);
    store.setMode('plan');

    const snapshot = memento.snapshot() as { conversations: Array<{ id: string; mode: string }>; currentId: string | null };
    assert.ok(snapshot);
    assert.strictEqual(snapshot.currentId, conversation.id);
    assert.strictEqual(snapshot.conversations.length, 1);
    assert.strictEqual(snapshot.conversations[0].mode, 'plan');
  });

  test('runtime cli status is not persisted when runtime snapshot source is enabled', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    const store = new ConversationStore(memento as unknown as import('vscode').Memento, () => {});
    store.newConversation();
    store.setCliStatus(false, '0.0.1', 'cli down');

    const snapshot = memento.snapshot() as Record<string, unknown>;
    assert.strictEqual(Object.prototype.hasOwnProperty.call(snapshot, 'cliAvailable'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(snapshot, 'cliVersion'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(snapshot, 'cliDiagnostics'), false);
  });

  test('legacy runtime mode keeps persisted cli status for rollback switch', () => {
    const memento = new FakeMemento({
      currentId: null,
      conversations: []
    });
    const store = new ConversationStore(
      memento as unknown as import('vscode').Memento,
      () => {},
      { useRuntimeSnapshot: false },
    );
    store.newConversation();
    store.setCliStatus(false, '0.0.1', 'cli down');

    const snapshot = memento.snapshot() as {
      cliAvailable?: boolean;
      cliVersion?: string | null;
      cliDiagnostics?: string | null;
    };
    assert.strictEqual(snapshot.cliAvailable, false);
    assert.strictEqual(snapshot.cliVersion, '0.0.1');
    assert.strictEqual(snapshot.cliDiagnostics, 'cli down');
  });
});
