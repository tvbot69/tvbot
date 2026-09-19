/**
 * fetch with a hard timeout. Provider clients without one can hang a command
 * past Discord's 3s interaction window (or forever in background jobs) when an
 * upstream stalls without closing the socket.
 */
export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = 10000,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  const combined = init.signal
    ? AbortSignal.any([init.signal, signal])
    : signal;
  try {
    return await fetch(url, { ...init, signal: combined });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Fetch timed out after ${timeoutMs}ms for ${String(url).slice(0, 120)}`);
    }
    throw err;
  }
}
