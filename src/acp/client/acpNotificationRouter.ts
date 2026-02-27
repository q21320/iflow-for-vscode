import { ChunkMapper } from '../../chunkMapper';
import { StreamChunk } from '../../protocol';
import { AcpProtocol } from '../../acpProtocol';
import { InactivityGuard } from '../inactivityGuard';
import { AcpDebugLogger } from '../debugLogger';
import { AcpNotificationEnvelope, AcpUsageExtractor } from './acpUsageExtractor';
import { isObject } from '../../shared/typeGuards';

export interface AcpNotificationRouterDeps {
  chunkMapper: ChunkMapper;
  debugLogger: AcpDebugLogger;
  usageExtractor: AcpUsageExtractor;
}

export class AcpNotificationRouter {
  constructor(private readonly deps: AcpNotificationRouterDeps) {}

  registerSessionUpdateHandler(
    protocol: AcpProtocol,
    onChunk: (chunk: StreamChunk) => void,
    inactivityGuard: InactivityGuard,
    debugLogging: boolean,
  ): void {
    protocol.onNotification('session/update', (params: unknown) => {
      const envelope = isObject(params) ? params as AcpNotificationEnvelope : {};
      const update = this.deps.usageExtractor.mergeEnvelopeUsage(params, envelope);
      inactivityGuard.markActivity(update);

      if (debugLogging) {
        this.deps.debugLogger.logSessionUpdateDebug(params, envelope, update);
      }

      const chunks = this.deps.chunkMapper.mapUpdateToChunks(update);
      for (const chunk of chunks) {
        onChunk(chunk);
      }
    });
  }
}
