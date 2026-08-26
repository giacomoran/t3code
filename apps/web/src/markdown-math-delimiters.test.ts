import { describe, expect, it } from "vite-plus/test";

import { normalizeLatexMathDelimiters } from "./markdown-math-delimiters";

/** Offsets into the source are spliced back into files, so length must not move. */
function expectSameLength(source: string): string {
  const result = normalizeLatexMathDelimiters(source);
  expect(result.length).toBe(source.length);
  return result;
}

describe("normalizeLatexMathDelimiters", () => {
  it("rewrites inline \\( \\) to single dollars", () => {
    expect(expectSameLength("The cost is \\(O(n)\\) overall.")).toBe(
      "The cost is  $O(n)$  overall.",
    );
  });

  it("rewrites \\[ \\] to double dollars", () => {
    expect(expectSameLength("\\[x^2\\]")).toBe("$$x^2$$");
  });

  it("rewrites a multi-line \\[ \\] block", () => {
    expect(expectSameLength("\\[\n\\frac{1}{2}\n\\]")).toBe("$$\n\\frac{1}{2}\n$$");
  });

  it("returns the input untouched when there is nothing to rewrite", () => {
    const source = "Plain prose with $existing$ math and no LaTeX delimiters.";

    expect(normalizeLatexMathDelimiters(source)).toBe(source);
  });

  it("leaves fenced code blocks alone", () => {
    const source = "Before \\(a\\)\n\n```sh\necho \\(not math\\)\n```\n\nAfter \\(b\\)";
    const result = expectSameLength(source);

    expect(result).toContain("echo \\(not math\\)");
    expect(result).toContain("Before  $a$ ");
    expect(result).toContain("After  $b$ ");
  });

  it("leaves tilde-fenced code blocks alone", () => {
    const source = "~~~\n\\(x\\)\n~~~";

    expect(expectSameLength(source)).toBe(source);
  });

  it("leaves inline code spans alone", () => {
    const source = "Use `printf \\(x\\)` and then \\(y\\).";
    const result = expectSameLength(source);

    expect(result).toContain("`printf \\(x\\)`");
    expect(result).toContain("then  $y$ .");
  });

  it("does not treat an escaped backslash as a delimiter", () => {
    const source = "A literal \\\\(not math\\\\) here.";

    expect(expectSameLength(source)).toBe(source);
  });

  it("leaves other markdown escapes untouched", () => {
    const source = "A \\* star and a \\_ underscore.";

    expect(normalizeLatexMathDelimiters(source)).toBe(source);
  });

  it("handles several formulas in one paragraph", () => {
    const result = expectSameLength("\\(a\\) then \\(b\\) then \\[c\\]");

    expect(result).toBe(" $a$  then  $b$  then $$c$$");
  });
});
