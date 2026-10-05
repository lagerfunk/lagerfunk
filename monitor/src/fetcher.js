// fetch with timeout, byte counting and early stop. Runtime neutral (Node 22 and Workers both have fetch,
// AbortController, TextDecoder and ReadableStream readers).
//
// Early stop matters for money: through a residential proxy you pay per GB, and most shops put the JSON-LD we need
// in the first few percent of the page. Cancelling the stream stops the download.
//
// Proxy options (pick one):
//   { fetch }     a fetch already routed through an HTTP CONNECT proxy (Node only, see platform/node.js)
//   { template }  an HTTP API style unblocker, "https://api.example.com/?key=K&url={url}" (works on Workers too;
//                 Workers cannot use CONNECT proxies at all)

export async function fetchText(fetchImpl, req, { timeoutMs = 20000, proxy = null, maxBytes = 2_500_000 } = {}) {
  const started = Date.now();
  let url = req.url;
  let doFetch = fetchImpl;
  let headers = { ...(req.headers ?? {}) };
  const viaProxy = Boolean(proxy);
  if (proxy?.template) {
    url = proxy.template.replace('{url}', encodeURIComponent(req.url));
    headers = { ...headers, ...(proxy.headers ?? {}) };
  } else if (proxy?.fetch) doFetch = proxy.fetch;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  let res;
  try {
    // Race against the abort too, so a fetch implementation that ignores the signal cannot hang a cron run.
    const aborted = new Promise((_, reject) => ac.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })), { once: true }));
    res = await Promise.race([doFetch(url, { method: req.method ?? 'GET', headers, body: req.body, redirect: 'follow', signal: ac.signal }), aborted]);
  } catch (e) {
    clearTimeout(timer);
    return { status: null, text: '', bytes: 0, truncated: false, url: req.url, viaProxy, ms: Date.now() - started, error: e?.name === 'AbortError' || /timeout/i.test(String(e?.message)) ? 'timeout' : `network:${e?.message ?? e}` };
  }
  const limit = req.maxBytes ?? maxBytes;
  let text = '';
  let bytes = 0;
  let truncated = false;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        text += dec.decode(value, { stream: true });
        if ((req.stopWhen && req.stopWhen(text)) || bytes >= limit) {
          truncated = true;
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
      }
      if (!truncated) text += dec.decode();
    } else {
      text = await res.text();
      bytes = text.length;
    }
  } catch (e) {
    clearTimeout(timer);
    return { status: res.status, text, bytes, truncated, url: req.url, finalUrl: res.url, viaProxy, ms: Date.now() - started, error: text ? null : e?.name === 'AbortError' ? 'timeout' : `read:${e?.message ?? e}` };
  }
  clearTimeout(timer);
  return { status: res.status, text, bytes, truncated, url: req.url, finalUrl: res.url || req.url, viaProxy, ms: Date.now() - started, error: null };
}
