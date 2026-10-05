// Streaming RFC 4180 CSV reader for product feeds (can be hundreds of MB). Handles quoted fields, doubled quotes,
// line breaks inside quotes, CRLF, a BOM and the delimiters Awin offers (comma, semicolon, tab, pipe).

export class CsvParser {
  constructor({ delimiter = ',' } = {}) {
    this.delim = delimiter;
    this.buf = '';
    this.re = new RegExp(`[${delimiter === '\t' ? '\\t' : delimiter === '|' ? '\\|' : delimiter === '.' ? '\\.' : delimiter}\\n\\r]`, 'g');
  }

  push(text) {
    this.buf += text;
    return this._drain(false);
  }

  end() {
    return this._drain(true);
  }

  _drain(eof) {
    const rows = [];
    let pos = 0;
    for (;;) {
      if (pos >= this.buf.length) break;
      const r = this._row(pos, eof);
      if (!r) break;
      rows.push(r.row);
      pos = r.next;
    }
    this.buf = this.buf.slice(pos);
    return rows;
  }

  // One row from `start`, or null when the buffer ends before the row does (and more data may come).
  _row(start, eof) {
    const buf = this.buf;
    const d = this.delim;
    let i = start;
    const cells = [];
    for (;;) {
      if (buf[i] === '"') {
        let j = i + 1;
        let val = '';
        for (;;) {
          const q = buf.indexOf('"', j);
          if (q < 0) {
            if (!eof) return null;
            cells.push(val + buf.slice(j));
            return { row: cells, next: buf.length };
          }
          val += buf.slice(j, q);
          if (q + 1 >= buf.length && !eof) return null; // cannot tell yet whether this quote is doubled
          if (buf[q + 1] === '"') {
            val += '"';
            j = q + 2;
            continue;
          }
          i = q + 1;
          break;
        }
        cells.push(val);
        this.re.lastIndex = i;
        const m = this.re.exec(buf); // skip stray characters between a closing quote and the next delimiter
        i = m ? m.index : buf.length;
      } else {
        this.re.lastIndex = i;
        const m = this.re.exec(buf);
        const k = m ? m.index : buf.length;
        if (k >= buf.length && !eof) return null;
        cells.push(buf.slice(i, k));
        i = k;
      }
      if (i >= buf.length) {
        if (!eof) return null;
        return { row: cells, next: i };
      }
      const c = buf[i];
      if (c === d) {
        i++;
        continue;
      }
      if (c === '\r') {
        if (i + 1 >= buf.length && !eof) return null;
        i += buf[i + 1] === '\n' ? 2 : 1;
      } else i++;
      return { row: cells, next: i };
    }
  }
}

/** Pick the delimiter from the header line. */
export function sniffDelimiter(firstLine) {
  const counts = [',', ';', '\t', '|'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/**
 * Async generator of records keyed by lower-cased header names. Blank lines are skipped.
 * `onHeader(headers)` is called once, so callers can check for required columns.
 */
export async function* csvRecords(chunks, { delimiter = null, onHeader = null } = {}) {
  let parser = null;
  let headers = null;
  const handle = function* (rows) {
    for (const cells of rows) {
      if (cells.length === 1 && cells[0].trim() === '') continue;
      if (!headers) {
        headers = cells.map((h) => h.trim().toLowerCase());
        onHeader?.(headers);
        continue;
      }
      const rec = {};
      for (let i = 0; i < headers.length; i++) if (!(headers[i] in rec)) rec[headers[i]] = cells[i] ?? '';
      yield rec;
    }
  };
  let pending = '';
  for await (const chunk of chunks) {
    if (!parser) {
      // wait for the whole header line before choosing the delimiter, so tiny first chunks cannot mislead the sniffer
      pending += chunk;
      if (!/[\r\n]/.test(pending)) continue;
      parser = new CsvParser({ delimiter: delimiter ?? sniffDelimiter(pending.split(/\r?\n/, 1)[0]) });
      yield* handle(parser.push(pending));
      pending = '';
      continue;
    }
    yield* handle(parser.push(chunk));
  }
  if (!parser && pending) {
    parser = new CsvParser({ delimiter: delimiter ?? sniffDelimiter(pending.split(/\r?\n/, 1)[0]) });
    yield* handle(parser.push(pending));
  }
  if (parser) yield* handle(parser.end());
}
