import fs from 'node:fs';

/** Index just past the string literal starting at text[i] (a double quote). */
function skipString(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** Parse JSON that may contain // and /* comments and trailing commas (tsconfig style). */
export function parseJsonc(text: string): unknown {
  // Editors on Windows sometimes save JSON with a byte-order mark, which JSON.parse rejects.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Pass 1: strip comments.
  let noComments = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = skipString(text, i);
      noComments += text.slice(i, end);
      i = end;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      noComments += ch;
      i++;
    }
  }
  // Pass 2: drop commas that are followed only by whitespace and a closing bracket.
  let out = '';
  i = 0;
  while (i < noComments.length) {
    const ch = noComments[i];
    if (ch === '"') {
      const end = skipString(noComments, i);
      out += noComments.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (noComments[j] === '}' || noComments[j] === ']') {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return JSON.parse(out);
}

export function readJsonFile(file: string): unknown | null {
  try {
    return parseJsonc(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
