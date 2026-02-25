import * as assert from 'assert';
import { WebviewHandler } from '../webviewHandler';
import * as vscode from 'vscode';

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

  test('getWorkspaceFileList passes limit to vscode.findFiles', async () => {
    const handler = new WebviewHandler(
      { fsPath: '/tmp/ext' } as unknown as import('vscode').Uri,
      new FakeMemento({ currentId: null, conversations: [] }) as unknown as import('vscode').Memento,
      new FakeSecrets() as unknown as import('vscode').SecretStorage,
    );

    const workspace = vscode.workspace as unknown as {
      workspaceFolders: Array<{ uri: { fsPath: string }; name: string }> | undefined;
      findFiles: (include: string, exclude: string, maxResults: number) => Promise<Array<{ fsPath: string }>>;
      getWorkspaceFolder: (uri: { fsPath: string }) => { uri: { fsPath: string }; name: string } | undefined;
    };

    const originalWorkspaceFolders = workspace.workspaceFolders;
    const originalFindFiles = workspace.findFiles;
    const originalGetWorkspaceFolder = workspace.getWorkspaceFolder;

    try {
      let capturedLimit = -1;
      workspace.workspaceFolders = [{ uri: { fsPath: '/root' }, name: 'root' }];
      workspace.findFiles = async (_include, _exclude, maxResults) => {
        capturedLimit = maxResults;
        return [{ fsPath: '/root/src/a.ts' }, { fsPath: '/root/src/b.ts' }];
      };
      workspace.getWorkspaceFolder = () => workspace.workspaceFolders?.[0];

      const files = await (handler as unknown as {
        getWorkspaceFileList: (cwd?: string, limit?: number) => Promise<string[]>;
      }).getWorkspaceFileList('/root', 12);

      assert.strictEqual(capturedLimit, 12);
      assert.deepStrictEqual(files, ['src/a.ts', 'src/b.ts']);
    } finally {
      workspace.workspaceFolders = originalWorkspaceFolders;
      workspace.findFiles = originalFindFiles;
      workspace.getWorkspaceFolder = originalGetWorkspaceFolder;
      await handler.dispose();
    }
  });

  test('getWorkspaceFileList keeps multi-root prefix behavior', async () => {
    const handler = new WebviewHandler(
      { fsPath: '/tmp/ext' } as unknown as import('vscode').Uri,
      new FakeMemento({ currentId: null, conversations: [] }) as unknown as import('vscode').Memento,
      new FakeSecrets() as unknown as import('vscode').SecretStorage,
    );

    const workspace = vscode.workspace as unknown as {
      workspaceFolders: Array<{ uri: { fsPath: string }; name: string }> | undefined;
      findFiles: (include: string, exclude: string, maxResults: number) => Promise<Array<{ fsPath: string }>>;
      getWorkspaceFolder: (uri: { fsPath: string }) => { uri: { fsPath: string }; name: string } | undefined;
    };

    const originalWorkspaceFolders = workspace.workspaceFolders;
    const originalFindFiles = workspace.findFiles;
    const originalGetWorkspaceFolder = workspace.getWorkspaceFolder;

    try {
      workspace.workspaceFolders = [
        { uri: { fsPath: '/root-a' }, name: 'A' },
        { uri: { fsPath: '/root-b' }, name: 'B' },
      ];
      workspace.findFiles = async () => [
        { fsPath: '/root-a/src/in-a.ts' },
        { fsPath: '/root-b/src/in-b.ts' },
      ];
      workspace.getWorkspaceFolder = (uri) => {
        if (uri.fsPath.startsWith('/root-a/')) {
          return workspace.workspaceFolders?.[0];
        }
        if (uri.fsPath.startsWith('/root-b/')) {
          return workspace.workspaceFolders?.[1];
        }
        return undefined;
      };

      const files = await (handler as unknown as {
        getWorkspaceFileList: (cwd?: string, limit?: number) => Promise<string[]>;
      }).getWorkspaceFileList('/root-a', 20);

      assert.deepStrictEqual(files, ['src/in-a.ts', '[B] src/in-b.ts']);
    } finally {
      workspace.workspaceFolders = originalWorkspaceFolders;
      workspace.findFiles = originalFindFiles;
      workspace.getWorkspaceFolder = originalGetWorkspaceFolder;
      await handler.dispose();
    }
  });
});
