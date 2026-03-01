import { AcpClient } from '../acpClient';

export interface CliAvailabilityResult {
  version: string | null;
  diagnostics: string;
}

export class CliStatusService {
  private static readonly CLI_CHECK_SUCCESS_TTL_MS = 2 * 60 * 1000;
  private static readonly CLI_CHECK_FAILURE_TTL_MS = 15 * 1000;
  private cache: { result: CliAvailabilityResult; checkedAt: number } | null = null;
  private inFlight: Promise<CliAvailabilityResult> | null = null;

  constructor(
    private readonly client: AcpClient,
    private readonly setStatus: (result: CliAvailabilityResult) => void,
    private readonly debug: (message: string) => void,
  ) {}

  invalidateCache(): void {
    this.cache = null;
    this.inFlight = null;
  }

  cacheResult(result: CliAvailabilityResult): void {
    this.cache = { result, checkedAt: Date.now() };
  }

  async check(forceRefresh = false): Promise<void> {
    const result = await this.getCliAvailability(forceRefresh);
    this.debug(`Setting CLI status: available=${result.version !== null}, diagnostics=${result.diagnostics}`);
    this.setStatus(result);
  }

  private async getCliAvailability(forceRefresh = false): Promise<CliAvailabilityResult> {
    if (forceRefresh) {
      this.debug('CLI availability check: force refresh requested');
      this.invalidateCache();
    }

    if (this.isCacheFresh() && this.cache) {
      this.debug('CLI availability check: using cache');
      return this.cache.result;
    }

    if (this.inFlight) {
      this.debug('CLI availability check: awaiting in-flight check');
      return this.inFlight;
    }

    this.debug('CLI availability check: running client.checkAvailability()');
    this.inFlight = this.client.checkAvailability()
      .then((result) => {
        this.debug(`CLI availability check complete: available=${result.version !== null}, version=${result.version ?? 'n/a'}`);
        this.cacheResult(result);
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private isCacheFresh(): boolean {
    if (!this.cache) {
      return false;
    }

    const ttl = this.cache.result.version !== null
      ? CliStatusService.CLI_CHECK_SUCCESS_TTL_MS
      : CliStatusService.CLI_CHECK_FAILURE_TTL_MS;
    return Date.now() - this.cache.checkedAt < ttl;
  }
}
