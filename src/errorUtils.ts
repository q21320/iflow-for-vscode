export type AppErrorCode = 'UNKNOWN' | 'MISSING_SESSION' | 'CLI_UNAVAILABLE';

export interface AppErrorOptions {
  code?: AppErrorCode;
  cause?: unknown;
  details?: unknown;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code ?? 'UNKNOWN';
    this.details = options.details;
  }
}

export function normalizeErrorMessage(value: unknown, fallback = 'Unknown error'): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || fallback;
  }

  if (value instanceof Error) {
    const trimmed = value.message.trim();
    return trimmed || fallback;
  }

  if (value === null || value === undefined) {
    return fallback;
  }

  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === 'string') {
      const trimmed = serialized.trim();
      if (trimmed && trimmed !== '{}' && trimmed !== '[]') {
        return trimmed;
      }
    }
  } catch {
    // Ignore JSON serialization failures and fall through.
  }

  const stringified = String(value).trim();
  return stringified || fallback;
}

export function classifyAppErrorCode(value: unknown): AppErrorCode {
  const normalized = normalizeErrorMessage(value, '').toLowerCase();
  if (!normalized) {
    return 'UNKNOWN';
  }

  if (normalized.includes('session not found')
    || (normalized.includes('session') && normalized.includes('not found'))) {
    return 'MISSING_SESSION';
  }

  if (normalized.includes('connect')
    || normalized.includes('econnrefused')
    || normalized.includes('socket hang up')
    || normalized.includes('econnreset')
    || normalized.includes('epipe')
    || normalized.includes('not available')
    || normalized.includes('cli not found')) {
    return 'CLI_UNAVAILABLE';
  }

  return 'UNKNOWN';
}

export function toAppError(value: unknown, fallback = 'Unknown error'): AppError {
  if (value instanceof AppError) {
    if (value.message.trim()) {
      return value;
    }

    return new AppError(fallback, {
      code: value.code,
      cause: value.cause,
      details: value.details,
    });
  }

  const code = classifyAppErrorCode(value);
  const message = normalizeErrorMessage(value, fallback);
  if (value instanceof Error) {
    return new AppError(message, { code, cause: value });
  }

  return new AppError(message, { code, details: value });
}
