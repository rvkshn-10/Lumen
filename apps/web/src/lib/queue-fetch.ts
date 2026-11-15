// The API runs one heavy calculation at a time and answers 429 "queue_full"
// while another is in progress. Switching sites quickly (or React's dev-mode
// double effects) cancels a request in the browser but not on the server, so
// the next request lands while the old one is still finishing. Wait and retry
// instead of showing an error.
const RETRYABLE = 429;
const MAX_WAIT_MS = 45_000;

function sleep(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export async function queueFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(input, init);
    if (response.status !== RETRYABLE || Date.now() - started > MAX_WAIT_MS) return response;
    const header = Number(response.headers.get("Retry-After"));
    const wait = Number.isFinite(header) && header > 0 ? header * 1000 : Math.min(400 + attempt * 300, 2000);
    await sleep(wait, init.signal);
  }
}
