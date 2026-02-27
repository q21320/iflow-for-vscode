import { StreamChunk } from '../../protocol';
import { UsageChunkMapper } from '../../chunkMapper/usageChunkMapper';
import { isObject } from '../../shared/typeGuards';

export interface AcpNotificationEnvelope {
  sessionId?: string;
  update?: unknown;
  usageMetadata?: unknown;
  usage?: unknown;
  tokenUsage?: unknown;
}

export class AcpUsageExtractor {
  private readonly usageMapper = new UsageChunkMapper();

  mergeEnvelopeUsage(params: unknown, envelope: AcpNotificationEnvelope): unknown {
    const update = envelope.update ?? params;
    if (!isObject(update)) {
      return update;
    }

    const merged: Record<string, unknown> = { ...update };
    for (const key of ['usageMetadata', 'usage', 'tokenUsage'] as const) {
      const value = envelope[key];
      if (value !== undefined && merged[key] === undefined) {
        merged[key] = value;
      }
    }
    return merged;
  }

  extractUsageChunk(payload: unknown): StreamChunk | null {
    return this.usageMapper.extractFromPayload(payload);
  }
}
