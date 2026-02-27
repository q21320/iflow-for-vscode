import { RunOptionsLike } from './types';

export function buildPrompt(options: RunOptionsLike): string {
  let prompt = '';

  if (options.cwd) {
    prompt += `=== Working Directory ===\n${options.cwd}\n=== End Working Directory ===\n\n`;
  }

  if (options.workspaceFiles && options.workspaceFiles.length > 0) {
    prompt += '=== Workspace Files ===\n';
    prompt += options.workspaceFiles.join('\n');
    prompt += '\n=== End Workspace Files ===\n\n';
  }

  const ctx = options.ideContext;
  if (ctx && (ctx.activeFile || ctx.selection)) {
    prompt += '=== IDE Context ===\n';
    if (ctx.activeFile) {
      prompt += `Active File: ${ctx.activeFile.path}\n`;
    }
    if (ctx.selection) {
      prompt += `Selected Text (${ctx.selection.fileName}:${ctx.selection.lineStart}-${ctx.selection.lineEnd}):\n`;
      prompt += ctx.selection.text;
      prompt += '\n';
    }
    prompt += '=== End IDE Context ===\n\n';
  }

  if (options.attachedFiles.length > 0) {
    prompt += '=== Attached Files ===\n';
    for (const file of options.attachedFiles) {
      prompt += `--- ${file.path} ---\n`;
      prompt += file.content || '';
      if (file.truncated) {
        prompt += '\n[... truncated ...]\n';
      }
      prompt += '\n';
    }
    prompt += '=== End Attached Files ===\n\n';
  }

  prompt += options.prompt;
  return prompt;
}
