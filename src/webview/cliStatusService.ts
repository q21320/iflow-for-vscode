import { AcpClient } from '../acpClient';

export interface CliAvailabilityResult {
  version: string | null;
  diagnostics: string;
}

export class CliStatusService {
  private static readonly CLI_CHECK_SUCCESS_TTL_MS = 2 * 60 * 1000;
  private static readonly CLI_CHECK_FAILURE_TTL_MS = 15 * 1000;
  private static sharedCliCheckCache: { result: CliAvailabilityResult; checkedAt: number } | null = null;
  private static sharedCliCheckInFlight: Promise<CliAvailabilityResult> | null = null;

  constructor(
    private readonly client: AcpClient,
    private readonly setStatus: (result: CliAvailabilityResult) => void,
    private readonly debug: (message: string) => void,
  ) {}

  static invalidateSharedCliCheck(): void {
    this.sharedCliCheckCache = null;
    this.sharedCliCheckInFlight = null;
  }

  static cacheCliCheckResult(result: CliAvailabilityResult): void {
    this.sharedCliCheckCache = { result, checkedAt: Date.now() };
  }

  async check(forceRefresh = false): Promise<void> {
    const result = await this.getSharedCliAvailability(forceRefresh);
    this.debug(`Setting CLI status: available=${result.version !== null}, diagnostics=${result.diagnostics}`);
    this.setStatus(result);
  }

  private async getSharedCliAvailability(forceRefresh = false): Promise<CliAvailabilityResult> {
    if (forceRefresh) {
      this.debug('CLI availability check: force refresh requested');
      CliStatusService.invalidateSharedCliCheck();
    }

    if (CliStatusService.isSharedCliCheckFresh() && CliStatusService.sharedCliCheckCache) {
      this.debug('CLI availability check: using shared cache');
      return CliStatusService.sharedCliCheckCache.result;
    }

    if (CliStatusService.sharedCliCheckInFlight) {
      this.debug('CLI availability check: awaiting in-flight check');
      return CliStatusService.sharedCliCheckInFlight;
    }

    this.debug('CLI availability check: running client.checkAvailability()');
    CliStatusService.sharedCliCheckInFlight = this.client.checkAvailability()
      .then((result) => {
        this.debug(`CLI availability check complete: available=${result.version !== null}, version=${result.version ?? 'n/a'}`);
        CliStatusService.cacheCliCheckResult(result);
        return result;
      })
      .finally(() => {
        CliStatusService.sharedCliCheckInFlight = null;
      });

    return CliStatusService.sharedCliCheckInFlight;
  }

  private static isSharedCliCheckFresh(): boolean {
    if (!this.sharedCliCheckCache) {
      return false;
    }

    const ttl = this.sharedCliCheckCache.result.version !== null
      ? this.CLI_CHECK_SUCCESS_TTL_MS
      : this.CLI_CHECK_FAILURE_TTL_MS;
    return Date.now() - this.sharedCliCheckCache.checkedAt < ttl;
  }
}
