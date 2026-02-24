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
