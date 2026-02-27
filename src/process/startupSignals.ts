export function isReadySignal(output: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes('listening')
    || normalized.includes('ready')
    || normalized.includes('started websocket service')
    || normalized.includes('server started');
}

export function isAddressInUseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('eaddrinuse')
    || normalized.includes('address already in use')
    || normalized.includes('failed to bind acp port');
}

export function extractManagedPort(output: string): number | null {
  const patterns = [
    /\busing port[:\s]+(\d{2,5})\b/i,
    /\bfound available port\s+(\d{2,5})\b/i,
    /\blistening(?:\s+on)?(?:\s+port)?[:\s]+(\d{2,5})\b/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (!match) {
      continue;
    }
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
  }
  return null;
}

export function buildStartupFailureMessage(
  code: number | null,
  stdoutBuffer: string[],
  stderrBuffer: string[],
  configuredPort: number,
): string {
  const combined = `${stdoutBuffer.join('')}\n${stderrBuffer.join('')}`.toLowerCase();
  if (combined.includes('eaddrinuse') || combined.includes('address already in use')) {
    return `iFlow process failed to bind ACP port ${configuredPort} because it is already in use. `
      + 'Please close the conflicting process or change iflow.port.';
  }

  let errorMsg = `iFlow process exited immediately with code ${code}`;
  if (code === 1) {
    errorMsg += '. 可能的原因：--experimental-acp 参数不被支持，请检查 CLI 版本';
  }
  return errorMsg;
}
