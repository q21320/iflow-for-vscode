import { StreamChunk } from '../protocol';
import { ThinkingParser } from '../thinkingParser';
import { SessionUpdateContent } from './types';

export class ThinkingChunkMapper {
  private parser: ThinkingParser | null = null;
  private inNativeThinking = false;

  reset(): void {
    this.inNativeThinking = false;
    this.parser = new ThinkingParser();
  }

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

  mapAgentThoughtChunk(content: SessionUpdateContent | undefined): StreamChunk[] {
    const chunks: StreamChunk[] = [];
    if (content?.type === 'text' && typeof content.text === 'string') {
      if (!this.inNativeThinking) {
        chunks.push({ chunkType: 'thinking_start' });
        this.inNativeThinking = true;
      }
      chunks.push({ chunkType: 'thinking_content', content: content.text });
    }
    return chunks;
  }

  mapAgentMessageChunk(content: SessionUpdateContent | undefined): StreamChunk[] {
    const chunks: StreamChunk[] = [];
    if (content?.type === 'text' && typeof content.text === 'string') {
      if (this.inNativeThinking) {
        chunks.push({ chunkType: 'thinking_end' });
        this.inNativeThinking = false;
      }
      chunks.push(...this.mapTextThroughParser(content.text));
    }
    return chunks;
  }

  mapLegacyAssistantChunk(chunk: { thought?: string; text?: string } | undefined): StreamChunk[] {
    const chunks: StreamChunk[] = [];

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

    return chunks;
  }

  handleTaskFinish(): StreamChunk[] {
    if (!this.inNativeThinking) {
      return [];
    }
    this.inNativeThinking = false;
    return [{ chunkType: 'thinking_end' }];
  }

  private mapTextThroughParser(text: string): StreamChunk[] {
    if (this.parser) {
      return this.parser.parse(text);
    }
    return [{ chunkType: 'text', content: text }];
  }
}
