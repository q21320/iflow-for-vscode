// Pure mapping logic: converts ACP session/update payloads into StreamChunks
// for the webview. No SDK dependency.

import { StreamChunk, AttachedFile, IDEContext } from './protocol';
import { ThinkingParser } from './thinkingParser';

interface RunOptionsLike {
  prompt: string;
  attachedFiles: AttachedFile[];
  workspaceFiles?: string[];
  ideContext?: IDEContext;
  cwd?: string;
}

interface ToolContentText {
  type?: string;
  text?: string;
}

interface ToolContentEntry {
  type?: string;
  content?: ToolContentText;
  path?: string;
  newText?: string;
  oldText?: string | null;
  fileDiff?: string;
}

interface ToolLocation {
  path?: string;
}

interface SessionUpdateContent {
  type?: string;
  text?: string;
}

interface SessionUpdatePayload {
  sessionUpdate?: string;
  content?: unknown;
  toolName?: string;
  title?: string | null;
  status?: string | null;
  args?: Record<string, unknown>;
  entries?: Array<{ content?: string; status?: string; priority?: string }>;
  locations?: ToolLocation[] | null;
  output?: unknown;
  type?: string;
  chunk?: { thought?: string; text?: string };
  label?: string | null;
  message?: string;
}

const LEGACY_MESSAGE_TYPE = {
  ASSISTANT: 'assistant',
  TOOL_CALL: 'tool_call',
  PLAN: 'plan',
  ERROR: 'error',
  TASK_FINISH: 'task_finish',
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class ChunkMapper {
  private parser: ThinkingParser | null = null;
  private inNativeThinking = false;

  constructor(
    private log: (message: string) => void
  ) {}

  /** Reset state at the start of each run. */
  reset(): void {
    this.inNativeThinking = false;
    this.parser = new ThinkingParser();
  }

  /** Flush any buffered parser state at the end of a run. */
  flushToChunks(): StreamChunk[] {
    const chunks: StreamChunk[] = [];

    if (this.parser) {
      chunks.push(...this.parser.parse(''));
    }

    if (this.inNativeThinking) {
      chunks.push({ chunkType: 'thinking_end' });
      this.inNativeThinking = false;
    }

    return chunks;
  }

  /** Build the final prompt string with workspace and attached file context. */
  buildPrompt(options: RunOptionsLike): string {
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

  /**
   * Enrich tool input by merging data from args/content/locations into one
   * object so the webview can render previews consistently.
   */
  enrichToolInput(message: {
    args?: Record<string, unknown>;
    label?: string;
    content?: unknown;
    locations?: unknown;
  }): Record<string, unknown> {
    const input: Record<string, unknown> = { ...(message.args || {}) };

    // If args is empty, try to parse from label (subagent format: "toolName: {json}")
    if (Object.keys(input).length === 0 && message.label) {
      const colonIdx = message.label.indexOf(': ');
      if (colonIdx > 0) {
        const jsonPart = message.label.substring(colonIdx + 2).trim();
        if (jsonPart.startsWith('{')) {
          try {
            const parsed = JSON.parse(jsonPart);
            if (isObject(parsed)) {
              Object.assign(input, parsed);
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    }

    // Map absolute_path to file_path if not already set.
    if (input.absolute_path && !input.file_path) {
      input.file_path = input.absolute_path;
    }

    // New ACP shape: content is an array of tool result items.
    if (Array.isArray(message.content)) {
      for (const item of message.content as ToolContentEntry[]) {
        if (!isObject(item)) {
          continue;
        }

        if (typeof item.path === 'string' && !input.file_path) {
          input.file_path = item.path;
        }
        if (item.newText !== undefined && input.content === undefined) {
          input.content = item.newText;
        }
        if (item.oldText !== undefined && input.old_string === undefined) {
          input.old_string = item.oldText;
        }
        if (typeof item.fileDiff === 'string') {
          input.file_diff = item.fileDiff;
        }

        if (isObject(item.content) && typeof item.content.text === 'string') {
          input._text = item.content.text;
        }
      }
    }

    // Legacy shape: single content object.
    if (isObject(message.content) && !Array.isArray(message.content)) {
      const content = message.content as Record<string, unknown>;

      if (typeof content.path === 'string' && !input.file_path) {
        input.file_path = content.path;
      }
      if (content.newText !== undefined && input.content === undefined) {
        input.content = content.newText;
      }
      if (content.oldText !== undefined && input.old_string === undefined) {
        input.old_string = content.oldText;
      }
      if (content.markdown !== undefined) {
        input._markdown = content.markdown;
      }
      if (typeof content.type === 'string') {
        input._contentType = content.type;
      }
    }

    // Merge first location as file_path.
    if (Array.isArray(message.locations) && message.locations.length > 0) {
      const loc = message.locations[0] as ToolLocation;
      if (typeof loc.path === 'string' && !input.file_path) {
        input.file_path = loc.path;
      }
    }

    return input;
  }

  private mapTextThroughParser(text: string): StreamChunk[] {
    if (this.parser) {
      return this.parser.parse(text);
    }
    return [{ chunkType: 'text', content: text }];
  }

  private extractToolOutput(content: unknown): string | null {
    if (!Array.isArray(content)) {
      return null;
    }

    const outputs: string[] = [];

    for (const item of content as ToolContentEntry[]) {
      if (!isObject(item)) {
        continue;
      }

      if (item.type === 'content' && isObject(item.content) && item.content.type === 'text' && typeof item.content.text === 'string') {
        outputs.push(item.content.text);
        continue;
      }

      if (item.type === 'diff') {
        if (typeof item.content === 'string') {
          outputs.push(item.content);
          continue;
        }
        if (typeof item.fileDiff === 'string') {
          outputs.push(item.fileDiff);
          continue;
        }
        if (typeof item.path === 'string') {
          outputs.push(`Updated ${item.path}`);
        }
      }
    }

    return outputs.length > 0 ? outputs.join('\n') : null;
  }

  private normalizeToolLabel(label: unknown): string | undefined {
    if (typeof label !== 'string') {
      return undefined;
    }

    const colonIdx = label.indexOf(': ');
    if (colonIdx > 0) {
      const afterColon = label.substring(colonIdx + 2).trim();
      if (afterColon.startsWith('{') || afterColon.startsWith('[')) {
        return undefined;
      }
    }

    return label;
  }

  private mapToolUpdate(update: SessionUpdatePayload): StreamChunk[] {
    const chunks: StreamChunk[] = [];

    const status = typeof update.status === 'string'
      ? update.status
      : update.sessionUpdate === 'tool_call'
        ? 'pending'
        : 'in_progress';

    const toolName = update.toolName || (typeof update.title === 'string' ? update.title : 'unknown');
    const enrichedInput = this.enrichToolInput({
      args: update.args,
      label: typeof update.title === 'string' ? update.title : undefined,
      content: update.content,
      locations: update.locations ?? undefined,
    });
    const cleanLabel = this.normalizeToolLabel(update.title);
    const output = this.extractToolOutput(update.content)
      ?? (typeof update.output === 'string' ? update.output : null);

    if (status === 'pending' || status === 'in_progress') {
      chunks.push({
        chunkType: 'tool_start',
        name: toolName,
        input: enrichedInput,
        label: cleanLabel,
      });

      if (output) {
        chunks.push({ chunkType: 'tool_output', content: output });
      }

      return chunks;
    }

    if (status === 'completed' || status === 'failed') {
      if (Object.keys(enrichedInput).length > 0) {
        chunks.push({
          chunkType: 'tool_start',
          name: toolName,
          input: enrichedInput,
          label: cleanLabel,
        });
      }

      if (output) {
        chunks.push({ chunkType: 'tool_output', content: output });
      }

      chunks.push({
        chunkType: 'tool_end',
        status: status === 'completed' ? 'completed' : 'error',
      });
    }

    return chunks;
  }

  /**
   * Map a single ACP session/update payload into one or more StreamChunks.
   */
  mapUpdateToChunks(payload: unknown): StreamChunk[] {
    const chunks: StreamChunk[] = [];

    if (!isObject(payload)) {
      return chunks;
    }

    const update = payload as SessionUpdatePayload;

    // ACP 0.5.13 format: { sessionUpdate: ... }
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk': {
        const content = update.content as SessionUpdateContent | undefined;
        if (content?.type === 'text' && typeof content.text === 'string') {
          if (!this.inNativeThinking) {
            chunks.push({ chunkType: 'thinking_start' });
            this.inNativeThinking = true;
          }
          chunks.push({ chunkType: 'thinking_content', content: content.text });
        }
        return chunks;
      }

      case 'agent_message_chunk': {
        const content = update.content as SessionUpdateContent | undefined;
        if (content?.type === 'text' && typeof content.text === 'string') {
          if (this.inNativeThinking) {
            chunks.push({ chunkType: 'thinking_end' });
            this.inNativeThinking = false;
          }
          chunks.push(...this.mapTextThroughParser(content.text));
        }
        return chunks;
      }

      case 'tool_call':
      case 'tool_call_update':
        return this.mapToolUpdate(update);

      case 'plan':
        if (Array.isArray(update.entries)) {
          chunks.push({
            chunkType: 'plan',
            entries: update.entries.map((entry) => ({
              content: entry.content || '',
              status: entry.status || 'pending',
              priority: entry.priority || 'medium',
            })),
          });
        }
        return chunks;

      case 'available_commands_update':
      case 'user_message_chunk':
        return chunks;

      default:
        break;
    }

    // Backward compatibility path for old local test fixtures.
    const legacyType = typeof update.type === 'string' ? update.type : undefined;

    switch (legacyType) {
      case LEGACY_MESSAGE_TYPE.ASSISTANT: {
        const chunk = update.chunk as { thought?: string; text?: string } | undefined;
        if (chunk?.thought) {
          if (!this.inNativeThinking) {
            chunks.push({ chunkType: 'thinking_start' });
            this.inNativeThinking = true;
          }
          chunks.push({ chunkType: 'thinking_content', content: chunk.thought });
        }

        if (chunk?.text) {
          if (this.inNativeThinking) {
            chunks.push({ chunkType: 'thinking_end' });
            this.inNativeThinking = false;
          }
          chunks.push(...this.mapTextThroughParser(chunk.text));
        }
        break;
      }

      case LEGACY_MESSAGE_TYPE.TOOL_CALL:
        return this.mapToolUpdate({
          sessionUpdate: 'tool_call_update',
          toolName: update.toolName as string | undefined,
          title: update.label as string | null | undefined,
          status: update.status as string | null | undefined,
          args: update.args as Record<string, unknown> | undefined,
          content: update.content,
          locations: Array.isArray(update.locations) ? update.locations as ToolLocation[] : null,
        });

      case LEGACY_MESSAGE_TYPE.PLAN:
        if (Array.isArray(update.entries)) {
          chunks.push({
            chunkType: 'plan',
            entries: (update.entries as Array<{ content?: string; status?: string; priority?: string }>).map((entry) => ({
              content: entry.content || '',
              status: entry.status || 'pending',
              priority: entry.priority || 'medium',
            })),
          });
        }
        break;

      case LEGACY_MESSAGE_TYPE.ERROR:
        chunks.push({
          chunkType: 'error',
          message: typeof update.message === 'string' ? update.message : 'Unknown error',
        });
        break;

      case LEGACY_MESSAGE_TYPE.TASK_FINISH:
        if (this.inNativeThinking) {
          chunks.push({ chunkType: 'thinking_end' });
          this.inNativeThinking = false;
        }
        break;

      default:
        this.log(`Unknown session update payload: ${JSON.stringify(payload).substring(0, 200)}`);
    }

    return chunks;
  }
}
