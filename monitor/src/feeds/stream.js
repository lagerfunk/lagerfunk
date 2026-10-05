// Turn a download (fetch Response, ReadableStream, bytes or string) into decoded text chunks, unzipping gzip on the way.
// Runtime neutral: Node 22 and Workers both have ReadableStream, DecompressionStream and TextDecoder.
// Awin serves `compression/gzip` as a plain .gz body (no Content-Encoding), so we sniff the 1f 8b magic bytes
// instead of trusting headers. A truncated gzip body makes the generator throw, which callers treat as "incomplete".

const enc = new TextEncoder();

async function* bytesOf(source) {
  if (typeof source === 'string') {
    yield enc.encode(source);
    return;
  }
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  const body = source?.body !== undefined ? source.body : source;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
  } else if (body && body[Symbol.asyncIterator]) {
    for await (const c of body) yield typeof c === 'string' ? enc.encode(c) : c;
  } else if (body instanceof Uint8Array) {
    yield body;
  } else {
    throw new Error('feed:unreadable_body');
  }
}

/** Async generator of strings. Throws `feed:too_large` past maxBytes of decoded text. */
export async function* textChunks(source, { maxBytes = 1_500_000_000, charset = null } = {}) {
  const it = bytesOf(source)[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return;
  const head = first.value;
  const gz = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  const raw = new ReadableStream({
    async pull(controller) {
      if (!raw.sent) {
        raw.sent = true;
        controller.enqueue(head);
        return;
      }
      const n = await it.next();
      if (n.done) controller.close();
      else controller.enqueue(n.value);
    },
    async cancel() {
      await it.return?.();
    },
  });
  const stream = gz ? raw.pipeThrough(new DecompressionStream('gzip')) : raw;
  const dec = new TextDecoder(charset || 'utf-8');
  const reader = stream.getReader();
  let total = 0;
  let first_ = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('feed:too_large');
      let text = dec.decode(value, { stream: true });
      if (first_) {
        first_ = false;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      if (text) yield text;
    }
    const tail = dec.decode();
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

/** charset=... from a Content-Type header value, only for encodings TextDecoder knows and that are not UTF-8. */
export function charsetOf(contentType) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType ?? '');
  if (!m) return null;
  const c = m[1].toLowerCase();
  if (c === 'utf-8' || c === 'utf8') return null;
  try {
    new TextDecoder(c);
    return c;
  } catch {
    return null;
  }
}
