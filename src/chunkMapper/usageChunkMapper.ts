import { StreamChunk } from '../protocol';
import { SessionUpdatePayload } from './types';
import { isObject } from '../shared/typeGuards';

export class UsageChunkMapper {
  withUsage(chunks: StreamChunk[], update: SessionUpdatePayload): StreamChunk[] {
    const usageChunk = this.extractFromUpdate(update);
    if (!usageChunk) {
      return chunks;
    }
    return [...chunks, usageChunk];
  }

  extractFromUpdate(update: SessionUpdatePayload): StreamChunk | null {
    return this.extractFromSources([
      update.usageMetadata,
      update.usage,
      update.tokenUsage,
      update.output,
      update.content,
    ]);
  }

  extractFromPayload(payload: unknown): StreamChunk | null {
    if (!isObject(payload)) {
      return null;
    }

    const sources: Array<unknown> = [payload];
    for (const key of ['usageMetadata', 'usage', 'tokenUsage'] as const) {
      sources.push(payload[key]);
    }
    return this.extractFromSources(sources);
  }

  private extractFromSources(candidates: unknown[]): StreamChunk | null {
    const sources: Array<Record<string, unknown>> = [];
    for (const candidate of candidates) {
      if (isObject(candidate)) {
        sources.push(candidate);
      }
    }

    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let totalTokens: number | undefined;

    for (const source of sources) {
      if (promptTokens === undefined) {
        promptTokens = this.pickUsageField(source, ['promptTokenCount', 'prompt_tokens', 'input_tokens']);
      }
      if (completionTokens === undefined) {
        completionTokens = this.pickUsageField(source, ['candidatesTokenCount', 'completion_tokens', 'output_tokens']);
      }
      if (totalTokens === undefined) {
        totalTokens = this.pickUsageField(source, ['totalTokenCount', 'total_tokens']);
      }
    }

    if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
      return null;
    }

    return {
      chunkType: 'usage',
      promptTokens,
      completionTokens,
      totalTokens,
    };
  }

  private toTokenCount(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return undefined;
    }
    return Math.max(0, Math.round(value));
  }

  private pickUsageField(source: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const parsed = this.toTokenCount(source[key]);
      if (parsed !== undefined) {
        return parsed;
      }
    }
    return undefined;
  }
}
