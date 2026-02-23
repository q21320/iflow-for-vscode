import * as assert from 'assert';
import { WebviewHandler } from '../webviewHandler';

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

class FakeSecrets {
  private data = new Map<string, string>();

  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.data.get(key));
  }

  store(key: string, value: string): Thenable<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Thenable<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
}

suite('WebviewHandler', () => {
  test('synthetic plan approval updates mode immediately', async () => {
    const handler = new WebviewHandler(
      { fsPath: '/tmp/ext' } as unknown as import('vscode').Uri,
      new FakeMemento({ currentId: null, conversations: [] }) as unknown as import('vscode').Memento,
      new FakeSecrets() as unknown as import('vscode').SecretStorage,
    );

    await handler.handleMessage({ type: 'planApproval', requestId: -1, option: 'smart' });

    const mode = handler.getStore().getCurrentConversation()?.mode;
    assert.strictEqual(mode, 'smart');

    await handler.dispose();
  });
});
