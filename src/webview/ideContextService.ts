import * as path from 'path';
import * as vscode from 'vscode';
import { IDEContext } from '../protocol';

export class IDEContextService {
  static build(maxSelectionChars: number): IDEContext {
    const editor = vscode.window.activeTextEditor;
    const context: IDEContext = { activeFile: null, selection: null };

    if (editor && editor.document.uri.scheme === 'file') {
      const filePath = editor.document.uri.fsPath;
      const fileName = path.basename(filePath);
      context.activeFile = { path: filePath, name: fileName };

      const selection = editor.selection;
      if (!selection.isEmpty) {
        const text = editor.document.getText(selection);
        const cappedText = text.length > maxSelectionChars
          ? text.substring(0, maxSelectionChars)
          : text;
        context.selection = {
          filePath,
          fileName,
          text: cappedText,
          lineStart: selection.start.line + 1,
          lineEnd: selection.end.line + 1,
        };
      }
    }

    return context;
  }
}
