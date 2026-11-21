// A fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// The reference reads one character at a time and grows every field by
// appending one character at a time. This module answers exactly the same
// way, but it never walks a field character by character when it can help
// it: it jumps from delimiter to delimiter with indexOf (which runs in
// native code) and cuts each field out with slice. Two gears:
//
//   - a whole-line gear for records whose line holds no quote at all: the
//     line is split on commas in one sweep, with a trailing CR stripped
//     when the line ends CRLF;
//   - a field gear for everything else: each field is read by finding the
//     next comma, line feed or carriage return, and each quoted field by
//     finding its closing quote, so a quoted field that spans lines or
//     holds doubled quotes is still handled without a per-character loop.
//
// The broken-row policy is csv-reader's own, reproduced field for field:
// a BOM at the very start is dropped; a record ends at LF or CRLF and a
// line left with no characters is no record; a CR outside quotes that is
// not followed by LF is dropped (stray_cr); a field that opens with a
// quote runs to the next quote that is not doubled, "" inside it is one
// quote, and each CRLF or lone CR inside it reads as LF; what follows a
// closing quote, up to the next comma or line break, is appended as it
// stands (quote_junk, when the field ends with anything appended); a
// quote that never closes is a literal character and the text after it is
// read again as unquoted (unterminated_quote); a quote inside an
// unquoted field is a literal character; fields stay strings, never
// trimmed or converted; columns is the first record when header is true,
// else null; rows are padded with "" (short_row) or cut (long_row) to the
// first record's width; each error is {code, line, row} in the order met,
// a record's short_row or long_row when the record ends, with line the
// 1-based line its record starts on and row its index in rows (null for
// the header).
//
// Pure and stateless across calls: every call to run() starts from fresh
// locals, nothing is cached from one case to the next, and the same input
// always gives the same answer, byte for byte.

const COMMA = 44; // ','
const LF = 10; // '\n'
const CR = 13; // '\r'
const QUOTE = 34; // '"'
const BOM = 0xfeff;

// How a field ended: at a comma, at a line break, or at the end of the text.
const END = 0;
const AT_COMMA = 1;
const AT_BREAK = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === BOM) pos = 1;

  // The record being read: the line it starts on and the index in rows
  // it takes (null while the header is still unread).
  let recordLine = 1;
  let recordRow = null;

  // Scratch slots for the field readers below, so no result object is
  // built per field: fValue is the field just read, fEnded how it ended,
  // fAdded how many characters the last unquoted read kept.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break. A CR not followed by LF is dropped (stray_cr) and the field
  // goes on. Sets fValue, fEnded and fAdded. The field is built lazily:
  // while no stray CR has shown up, the field is a single slice of the
  // text and no string is ever joined; only a stray CR forces the pieces
  // to be put together, so a clean field costs one slice and nothing else.
  function readUnquoted(value) {
    fAdded = 0;
    let base = value; // the part already joined, if any
    let seg = pos; // where the not-yet-joined slice starts
    while (pos < n) {
      const comma = text.indexOf(',', pos);
      const lf = text.indexOf('\n', pos);
      const cr = text.indexOf('\r', pos);
      let end = n;
      let kind = END;
      if (comma !== -1 && comma < end) {
        end = comma;
        kind = AT_COMMA;
      }
      if (lf !== -1 && lf < end) {
        end = lf;
        kind = AT_BREAK;
      }
      if (cr !== -1 && cr < end) {
        end = cr;
        kind = CR;
      }
      if (kind === CR && text.charCodeAt(end + 1) !== LF) {
        // A stray CR: join the slice up to it, drop the CR, and go on.
        if (end > seg) {
          const piece = text.slice(seg, end);
          base = base === '' ? piece : base + piece;
          fAdded += end - seg;
        }
        pushError('stray_cr');
        pos = end + 1;
        seg = pos;
        continue;
      }
      // The field ends here: its last slice is [seg, end).
      if (end > seg) {
        const piece = text.slice(seg, end);
        base = base === '' ? piece : base + piece;
        fAdded += end - seg;
      }
      if (kind === CR) {
        pos = end + 2;
        line += 1;
        fValue = base;
        fEnded = AT_BREAK;
        return;
      }
      if (kind === AT_COMMA) {
        pos = end + 1;
        fValue = base;
        fEnded = AT_COMMA;
        return;
      }
      if (kind === AT_BREAK) {
        pos = end + 1;
        line += 1;
        fValue = base;
        fEnded = AT_BREAK;
        return;
      }
      pos = n;
      fValue = base;
      fEnded = END;
      return;
    }
    fValue = base;
    fEnded = END;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue and
  // fEnded (fAdded is left holding the junk read's count, when there is
  // one, so the caller can tell junk from nothing).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let acc = '';
    let parts = null;
    let chunkStart = pos;

    // Takes the chunk [chunkStart, end): counts its line breaks, turns
    // each CRLF or lone CR inside it into one LF, and appends it to the
    // field being built.
    const takeChunk = (end) => {
      if (end === chunkStart) return;
      const nl = text.indexOf('\n', chunkStart);
      const hasNl = nl !== -1 && nl < end;
      const cr = text.indexOf('\r', chunkStart);
      const hasCr = cr !== -1 && cr < end;
      let piece;
      if (!hasNl && !hasCr) {
        piece = text.slice(chunkStart, end);
      } else if (!hasCr) {
        let count = 0;
        let at = chunkStart;
        for (;;) {
          const hit = text.indexOf('\n', at);
          if (hit === -1 || hit >= end) break;
          count += 1;
          at = hit + 1;
        }
        line += count;
        piece = text.slice(chunkStart, end);
      } else {
        piece = text.slice(chunkStart, end).replace(/\r\n?/g, '\n');
        let count = 0;
        let at = 0;
        for (;;) {
          const hit = piece.indexOf('\n', at);
          if (hit === -1) break;
          count += 1;
          at = hit + 1;
        }
        line += count;
      }
      if (parts !== null) {
        parts.push(piece);
      } else if (acc === '') {
        acc = piece;
      } else {
        parts = [acc, piece];
        acc = '';
      }
    };

    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the
        // text after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        readUnquoted('"');
        return;
      }
      if (text.charCodeAt(q + 1) === QUOTE) {
        // A doubled quote: one literal quote, and the field goes on.
        takeChunk(q);
        if (parts !== null) {
          parts.push('"');
        } else if (acc === '') {
          acc = '"';
        } else {
          parts = [acc, '"'];
          acc = '';
        }
        pos = q + 2;
        chunkStart = q + 2;
        continue;
      }
      takeChunk(q);
      fValue = parts !== null ? parts.join('') : acc;
      pos = q + 1;
      break;
    }

    if (pos >= n) {
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos += 1;
      fEnded = AT_COMMA;
      return;
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      fEnded = AT_BREAK;
      return;
    }
    if (c === CR && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      fEnded = AT_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquoted(fValue);
    if (fAdded > 0) pushError('quote_junk');
  }

  // Reads one record's fields into `fields`, then files the record:
  // the header, a data row, or nothing when the line held only stray CRs.
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];

    // Whole-line gear: the next physical line holds no quote and no
    // stray CR, so the record is one line and its fields split in a
    // single sweep. A trailing CR before the LF is the CRLF ending.
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? n : lf;
    const firstQuote = text.indexOf('"', pos);
    const hasQuote = firstQuote !== -1 && firstQuote < lineEnd;
    const firstCr = text.indexOf('\r', pos);
    let clean = !hasQuote;
    let contentEnd = lineEnd;
    if (clean && firstCr !== -1 && firstCr < lineEnd) {
      if (lf !== -1 && firstCr === lineEnd - 1) {
        contentEnd = lineEnd - 1;
      } else {
        clean = false;
      }
    }
    if (clean) {
      let from = pos;
      for (;;) {
        const comma = text.indexOf(',', from);
        if (comma === -1 || comma >= contentEnd) {
          fields.push(text.slice(from, contentEnd));
          break;
        }
        fields.push(text.slice(from, comma));
        from = comma + 1;
      }
      pos = lf === -1 ? n : lf + 1;
      if (lf !== -1) line += 1;
      finishRecord(fields, false);
      continue;
    }

    // Field gear: read field by field until the record ends.
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === QUOTE;
      if (quoted) {
        readQuoted();
      } else {
        readUnquoted('');
      }
      fields.push(fValue);
    } while (fEnded === AT_COMMA);
    finishRecord(fields, quoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
