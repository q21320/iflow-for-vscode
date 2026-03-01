import { StreamChunk } from "../protocol";
import { SessionUpdatePayload } from "./types";
import { isObject } from "../shared/typeGuards";

/** Keys that commonly wrap usage data in LLM API responses. */
const USAGE_CONTAINER_KEYS = [
  "usageMetadata",
  "usage",
  "tokenUsage",
  "token_usage",
  "result",
  "data",
  "response",
  "output",
  "content",
  "meta",
  "metadata",
] as const;

const PROMPT_TOKEN_KEYS = ["promptTokenCount", "prompt_tokens", "input_tokens"];
const COMPLETION_TOKEN_KEYS = [
  "candidatesTokenCount",
  "completion_tokens",
  "output_tokens",
];
const TOTAL_TOKEN_KEYS = ["totalTokenCount", "total_tokens"];

const MAX_SEARCH_DEPTH = 3;

export class UsageChunkMapper {
  withUsage(
    chunks: StreamChunk[],
    update: SessionUpdatePayload,
  ): StreamChunk[] {
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

    // Try shallow extraction first (fast path).
    const shallow = this.extractShallow(payload);
    if (shallow) {
      return shallow;
    }

    // Deep recursive search through nested objects.
    return this.extractDeep(payload, 0);
  }

  private extractShallow(payload: Record<string, unknown>): StreamChunk | null {
    const sources: Array<unknown> = [payload];
    for (const key of USAGE_CONTAINER_KEYS) {
      sources.push(payload[key]);
    }
    return this.extractFromSources(sources);
  }

  private extractDeep(
    obj: Record<string, unknown>,
    depth: number,
  ): StreamChunk | null {
    if (depth >= MAX_SEARCH_DEPTH) {
      return null;
    }

    for (const value of Object.values(obj)) {
      if (!isObject(value)) {
        continue;
      }
      const result = this.extractShallow(value);
      if (result) {
        return result;
      }
      const nested = this.extractDeep(value, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return null;
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
        promptTokens = this.pickUsageField(source, PROMPT_TOKEN_KEYS);
      }
      if (completionTokens === undefined) {
        completionTokens = this.pickUsageField(source, COMPLETION_TOKEN_KEYS);
      }
      if (totalTokens === undefined) {
        totalTokens = this.pickUsageField(source, TOTAL_TOKEN_KEYS);
      }
    }

    if (
      promptTokens === undefined &&
      completionTokens === undefined &&
      totalTokens === undefined
    ) {
      return null;
    }

    return {
      chunkType: "usage",
      promptTokens,
      completionTokens,
      totalTokens,
    };
  }

  private toTokenCount(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    return Math.max(0, Math.round(value));
  }

  private pickUsageField(
    source: Record<string, unknown>,
    keys: string[],
  ): number | undefined {
    for (const key of keys) {
      const parsed = this.toTokenCount(source[key]);
      if (parsed !== undefined) {
        return parsed;
      }
    }
    return undefined;
  }
}
