const ALLOWED_PROTOCOLS = new Set(['http', 'https', 'mailto']);

/**
 * Returns a safe href for markdown links, or null when the URL should be blocked.
 * Allowed schemes: http, https, mailto.
 */
export function sanitizeMarkdownLinkHref(rawHref: string): string | null {
  const trimmed = rawHref.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/[\u0000-\u001f\u007f\s]+/g, '');
  const schemeMatch = normalized.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) {
    return null;
  }

  const protocol = schemeMatch[1].toLowerCase();
  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol.toLowerCase() !== `${protocol}:`) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}
