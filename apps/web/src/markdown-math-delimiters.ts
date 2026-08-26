/**
 * Rewrite LaTeX's `\(…\)` and `\[…\]` delimiters to the `$…$` / `$$…$$` forms
 * remark-math understands.
 *
 * This has to happen on the source string rather than the syntax tree: in
 * CommonMark `\(` is an escape for a literal `(`, so by the time the markdown
 * is parsed the backslashes are gone and there is nothing left to detect.
 *
 * Every rewrite is **length-preserving**, which is a hard requirement, not a
 * stylistic one. Task-list toggling hands back a `markerOffset` into this same
 * source string and splices the file at that index (see `setMarkdownTaskChecked`),
 * so shifting any character would silently break checkboxes that follow a
 * formula. `\[`/`\]` map to `$$` exactly; `\(`/`\)` map to a padded `` $``/``$ ``
 * so the two characters stay two characters. The padding sits on the outside of
 * the delimiter, where it cannot break the "no space just inside the dollars"
 * rule that inline math relies on.
 *
 * Code is left alone: fenced blocks and inline spans are copied through
 * verbatim, so `\(` in a shell snippet stays a shell snippet.
 */

const OPEN_INLINE = " $";
const CLOSE_INLINE = "$ ";
const DISPLAY = "$$";

/** A fence opener at the start of a line: up to three spaces, then ``` or ~~~. */
function matchFenceOpen(
  source: string,
  index: number,
): { readonly marker: string; readonly length: number; readonly end: number } | null {
  let cursor = index;
  let indent = 0;
  while (indent < 3 && source[cursor] === " ") {
    cursor += 1;
    indent += 1;
  }
  const marker = source[cursor];
  if (marker !== "`" && marker !== "~") return null;
  let run = 0;
  while (source[cursor + run] === marker) run += 1;
  if (run < 3) return null;
  return { marker, length: run, end: cursor + run };
}

/** Index just past the fence that closes an open block, or the end of input. */
function findFenceClose(source: string, from: number, marker: string, length: number): number {
  let cursor = from;
  while (cursor < source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const stop = lineEnd === -1 ? source.length : lineEnd;
    const line = source.slice(cursor, stop);
    const trimmed = line.trimStart();
    if (trimmed.length - trimmed.replaceAll(marker, "").length >= length) {
      let run = 0;
      while (trimmed[run] === marker) run += 1;
      if (run >= length && trimmed.slice(run).trim().length === 0) {
        return stop === source.length ? stop : stop + 1;
      }
    }
    if (lineEnd === -1) return source.length;
    cursor = lineEnd + 1;
  }
  return source.length;
}

/** Index just past an inline code span opened by a run of `length` backticks. */
function findInlineCodeClose(source: string, from: number, length: number): number {
  let cursor = from;
  while (cursor < source.length) {
    if (source[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let run = 0;
    while (source[cursor + run] === "`") run += 1;
    if (run === length) return cursor + run;
    cursor += run;
  }
  // Unterminated run is not a code span at all; let the caller keep scanning.
  return -1;
}

export function normalizeLatexMathDelimiters(source: string): string {
  if (!source.includes("\\(") && !source.includes("\\[")) return source;

  let out = "";
  let index = 0;
  let atLineStart = true;

  while (index < source.length) {
    const char = source[index];

    // Fenced code block: copy the whole thing, delimiters and all.
    if (atLineStart) {
      const fence = matchFenceOpen(source, index);
      if (fence !== null) {
        const lineEnd = source.indexOf("\n", fence.end);
        const bodyStart = lineEnd === -1 ? source.length : lineEnd + 1;
        const close = findFenceClose(source, bodyStart, fence.marker, fence.length);
        out += source.slice(index, close);
        index = close;
        atLineStart = true;
        continue;
      }
    }

    // Inline code span.
    if (char === "`") {
      let run = 0;
      while (source[index + run] === "`") run += 1;
      const close = findInlineCodeClose(source, index + run, run);
      if (close !== -1) {
        out += source.slice(index, close);
        index = close;
        atLineStart = false;
        continue;
      }
    }

    if (char === "\\") {
      const next = source[index + 1];
      // An escaped backslash is not a delimiter opener; consume the pair so
      // `\\(` stays a literal backslash followed by a paren.
      if (next === "\\") {
        out += "\\\\";
        index += 2;
        atLineStart = false;
        continue;
      }
      if (next === "(") {
        out += OPEN_INLINE;
        index += 2;
        atLineStart = false;
        continue;
      }
      if (next === ")") {
        out += CLOSE_INLINE;
        index += 2;
        atLineStart = false;
        continue;
      }
      if (next === "[" || next === "]") {
        out += DISPLAY;
        index += 2;
        atLineStart = false;
        continue;
      }
    }

    out += char;
    atLineStart = char === "\n";
    index += 1;
  }

  return out;
}
