import { AppError, toAppError } from '../errorUtils';

export interface ErrorMapper {
  toAppError(error: unknown, fallback?: string): AppError;
  normalizeForWebview(error: unknown, fallback?: string): string;
}

export class DefaultErrorMapper implements ErrorMapper {
  toAppError(error: unknown, fallback = 'Unknown error'): AppError {
    return toAppError(error, fallback);
  }

  normalizeForWebview(error: unknown, fallback = 'Unknown error'): string {
    const mapped = this.toAppError(error, fallback);

    switch (mapped.code) {
      case 'CLI_UNAVAILABLE':
        return mapped.message || 'Unable to connect to iFlow CLI. Please re-check CLI settings.';
      case 'MISSING_SESSION':
        return mapped.message || 'Session expired. Please retry your request.';
      case 'VALIDATION_FAILED':
        return mapped.message || 'Invalid request payload.';
      case 'SECURITY_DENIED':
        return mapped.message || 'Operation is not allowed by workspace security policy.';
      case 'TIMEOUT':
        return mapped.message || 'The operation timed out. Please try again.';
      case 'IO_ERROR':
        return mapped.message || 'I/O operation failed.';
      case 'JSON_RPC_ERROR':
        return mapped.message || 'Protocol error while communicating with iFlow CLI.';
      case 'UNKNOWN':
      default:
        return mapped.message || fallback;
    }
  }
}
