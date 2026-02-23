const Module = require('module');

const originalLoad = Module._load;

const noopDisposable = { dispose() {} };
const outputChannel = {
  appendLine() {},
  dispose() {},
};

const mockVscode = {
  workspace: {
    getConfiguration() {
      return {
        get(_key, defaultValue) {
          return defaultValue;
        },
      };
    },
    workspaceFolders: [],
    onDidChangeConfiguration() {
      return noopDisposable;
    },
    onDidChangeWorkspaceFolders() {
      return noopDisposable;
    },
    findFiles: async () => [],
    getWorkspaceFolder: () => undefined,
  },
  window: {
    createOutputChannel() {
      return outputChannel;
    },
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor() {
      return noopDisposable;
    },
    onDidChangeTextEditorSelection() {
      return noopDisposable;
    },
    showOpenDialog: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  commands: {
    executeCommand: async () => undefined,
  },
  Uri: {
    file(fsPath) {
      return { fsPath };
    },
    joinPath(...parts) {
      const fsPath = parts.map((part) => (typeof part === 'string' ? part : part.fsPath)).join('/');
      return { fsPath };
    },
  },
  env: {
    openExternal: async () => true,
  },
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return mockVscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};
