import { StreamChunk } from '../protocol';
import { isObject } from '../shared/typeGuards';
import { buildPrompt as buildPromptText } from './promptBuilder';
import { ThinkingChunkMapper } from './thinkingChunkMapper';
import { ToolChunkMapper } from './toolChunkMapper';
import { UsageChunkMapper } from './usageChunkMapper';
import {
  LEGACY_MESSAGE_TYPE,
  RunOptionsLike,
  SessionUpdateContent,
  SessionUpdatePayload,
  ToolLocation,
} from './types';

export class ChunkMapper {
  private readonly thinkingMapper = new ThinkingChunkMapper();
  private readonly toolMapper = new ToolChunkMapper();
  private readonly usageMapper = new UsageChunkMapper();

  constructor(private log: (message: string) => void) {}

  /** Reset state at the start of each run. */
  reset(): void {
    this.thinkingMapper.reset();
  }

  /** Flush any buffered parser state at the end of a run. */
  flushToChunks(): StreamChunk[] {
    return this.thinkingMapper.flushToChunks();
  }

  /** Build the final prompt string with workspace and attached file context. */
  buildPrompt(options: RunOptionsLike): string {
    return buildPromptText(options);
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
    return this.toolMapper.enrichToolInput(message);
  }

  /**
   * Map a single ACP session/update payload into one or more StreamChunks.
   */
  mapUpdateToChunks(payload: unknown): StreamChunk[] {
    if (!isObject(payload)) {
      return [];
    }

    const update = payload as SessionUpdatePayload;

    // ACP 0.5.13 format: { sessionUpdate: ... }
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk': {
        const content = update.content as SessionUpdateContent | undefined;
        const chunks = this.thinkingMapper.mapAgentThoughtChunk(content);
        return this.usageMapper.withUsage(chunks, update);
      }

      case 'agent_message_chunk': {
        const content = update.content as SessionUpdateContent | undefined;
        const chunks = this.thinkingMapper.mapAgentMessageChunk(content);
        return this.usageMapper.withUsage(chunks, update);
      }

      case 'tool_call':
      case 'tool_call_update': {
        const chunks = this.toolMapper.mapToolUpdate(update);
        return this.usageMapper.withUsage(chunks, update);
      }

      case 'plan': {
        const chunks: StreamChunk[] = [];
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
        return this.usageMapper.withUsage(chunks, update);
      }

      case 'available_commands_update':
      case 'user_message_chunk':
        return this.usageMapper.withUsage([], update);

      default:
        break;
    }

    // Backward compatibility path for old local test fixtures.
    const legacyType = typeof update.type === 'string' ? update.type : undefined;
    const chunks: StreamChunk[] = [];

    switch (legacyType) {
      case LEGACY_MESSAGE_TYPE.ASSISTANT: {
        const chunk = update.chunk as { thought?: string; text?: string } | undefined;
        chunks.push(...this.thinkingMapper.mapLegacyAssistantChunk(chunk));
        break;
      }

      case LEGACY_MESSAGE_TYPE.TOOL_CALL: {
        const mapped = this.toolMapper.mapToolUpdate({
          sessionUpdate: 'tool_call_update',
          toolName: update.toolName as string | undefined,
          toolCallId: typeof update.toolCallId === 'string'
            ? update.toolCallId
            : (typeof update.id === 'string' ? update.id : undefined),
          title: update.label as string | null | undefined,
          status: update.status as string | null | undefined,
          args: update.args as Record<string, unknown> | undefined,
          content: update.content,
          locations: Array.isArray(update.locations) ? update.locations as ToolLocation[] : null,
          usageMetadata: update.usageMetadata,
          usage: update.usage,
          tokenUsage: update.tokenUsage,
        });
        return this.usageMapper.withUsage(mapped, update);
      }

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
        chunks.push(...this.thinkingMapper.handleTaskFinish());
        break;

      default:
        this.log(`Unknown session update payload: ${JSON.stringify(payload).substring(0, 200)}`);
    }

    return this.usageMapper.withUsage(chunks, update);
  }
}
