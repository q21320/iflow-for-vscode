import { StreamChunk } from '../protocol';
import { isObject } from '../shared/typeGuards';
import { SessionUpdatePayload, ToolContentEntry, ToolLocation } from './types';

export class ToolChunkMapper {
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

    this.normalizePathFields(input);

    // New ACP shape: content is an array of tool result items.
    if (Array.isArray(message.content)) {
      for (const item of message.content as ToolContentEntry[]) {
        if (!isObject(item)) {
          continue;
        }

        if (isObject(item.args)) {
          for (const [key, value] of Object.entries(item.args)) {
            if (input[key] === undefined) {
              input[key] = value;
            }
          }
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

    this.normalizePathFields(input);

    return input;
  }

  mapToolUpdate(update: SessionUpdatePayload): StreamChunk[] {
    const chunks: StreamChunk[] = [];

    const status = typeof update.status === 'string'
      ? update.status
      : update.sessionUpdate === 'tool_call'
        ? 'pending'
        : 'in_progress';
    const toolCallId = typeof update.toolCallId === 'string'
      ? update.toolCallId
      : undefined;

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
        toolCallId,
      });

      if (output) {
        chunks.push({ chunkType: 'tool_output', content: output, toolCallId });
      }

      return chunks;
    }

    if (status === 'completed' || status === 'failed') {
      if (toolCallId || Object.keys(enrichedInput).length > 0) {
        chunks.push({
          chunkType: 'tool_start',
          name: toolName,
          input: enrichedInput,
          label: cleanLabel,
          toolCallId,
        });
      }

      if (output) {
        chunks.push({ chunkType: 'tool_output', content: output, toolCallId });
      }

      chunks.push({
        chunkType: 'tool_end',
        status: status === 'completed' ? 'completed' : 'error',
        toolCallId,
      });
    }

    return chunks;
  }

  private normalizePathFields(input: Record<string, unknown>): void {
    if (input.absolute_path && !input.file_path) {
      input.file_path = input.absolute_path;
    }
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
}
