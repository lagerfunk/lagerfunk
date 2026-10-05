// Small streaming XML reader for product feeds (Tradedoubler). Not a general XML parser:
// it cuts repeated <product> blocks out of the stream and turns each block into a tiny tree.
// Namespace prefixes are dropped (ns2:name and name are the same), entities and CDATA are decoded.
import { decodeEntities } from '../util.js';

const strip = (n) => n.replace(/^[\w.-]+:/, '');

/** Async generator of raw `<tag ...>...</tag>` substrings. Blocks must not nest (products do not). */
export async function* xmlBlocks(chunks, tag) {
  const open = new RegExp(`<(?:[\\w.-]+:)?${tag}(?=[\\s>/])`);
  const close = new RegExp(`</(?:[\\w.-]+:)?${tag}\\s*>`);
  let buf = '';
  for await (const chunk of chunks) {
    buf += chunk;
    for (;;) {
      const o = open.exec(buf);
      if (!o) {
        // keep a short tail in case an opening tag is cut in half
        if (buf.length > 4096) buf = buf.slice(-256);
        break;
      }
      const rest = buf.slice(o.index);
      const c = close.exec(rest);
      if (!c) {
        buf = rest;
        break;
      }
      yield rest.slice(0, c.index + c[0].length);
      buf = rest.slice(c.index + c[0].length);
    }
  }
}

const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parse one element block into { name, attrs, children, text }. */
export function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const attrs = {};
      ATTR.lastIndex = 0;
      let a;
      while ((a = ATTR.exec(m[4] ?? ''))) attrs[strip(a[1])] = decodeEntities(a[2] ?? a[3]);
      const node = { name: strip(m[3]), attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) {
      top.text += decodeEntities(m[6]);
    }
  }
  return root.children[0] ?? null;
}

export const kids = (node, name) => (node?.children ?? []).filter((c) => c.name === name);
export const kid = (node, name) => kids(node, name)[0] ?? null;
export const textOf = (node) => (node ? node.text.trim() : '');

/** First descendant with this name (depth first). */
export function find(node, name) {
  for (const c of node?.children ?? []) {
    if (c.name === name) return c;
    const deeper = find(c, name);
    if (deeper) return deeper;
  }
  return null;
}
