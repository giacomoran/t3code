interface MarkdownAstNode {
  type: string;
  value?: unknown;
  children?: MarkdownAstNode[];
}

interface MarkdownRoot extends MarkdownAstNode {
  children?: MarkdownAstNode[];
}

/** Blank text between nodes is layout, not content, so it never blocks promotion. */
function isInsignificant(node: MarkdownAstNode): boolean {
  return node.type === "text" && typeof node.value === "string" && node.value.trim().length === 0;
}

/**
 * The sole meaningful child, or null when the node holds anything else.
 */
function onlyMeaningfulChild(node: MarkdownAstNode): MarkdownAstNode | null {
  const children = node.children;
  if (!children) return null;
  const meaningful = children.filter((child) => !isInsignificant(child));
  const first = meaningful[0];
  if (meaningful.length !== 1 || first === undefined) return null;
  return first;
}

/**
 * Promote a paragraph that contains nothing but one inline formula to display
 * math.
 *
 * micromark only parses `$$` as block math when the delimiters sit on their
 * own lines, so the very common single-line `$$E = mc^2$$` arrives as an
 * `inlineMath` node and renders cramped inside a sentence-height line. A
 * paragraph whose entire content is one formula is a displayed equation
 * regardless of how it was delimited, so this rewrites it to the `math` node
 * remark-math would have produced, which becomes `<div class="math
 * math-display">` for KaTeX to center.
 *
 * Must run after remark-math, which is what creates the nodes it inspects.
 */
/**
 * The mdast node remark-math emits for `$$\n...\n$$`, hast hints included.
 * rehype-katex renders `code.language-math` inside a `pre` in display mode.
 */
function displayMathNode(value: string): MarkdownAstNode {
  return {
    type: "math",
    value,
    data: {
      hName: "pre",
      hChildren: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-math", "math-display"] },
          children: [{ type: "text", value }],
        },
      ],
    },
  } as MarkdownAstNode;
}

export function remarkPromoteStandaloneMath() {
  return (tree: MarkdownRoot) => {
    const visit = (node: MarkdownAstNode) => {
      const children = node.children;
      if (!children) return;
      node.children = children.map((child) => {
        if (child.type === "paragraph") {
          const only = onlyMeaningfulChild(child);
          if (only !== null && only.type === "inlineMath") {
            return displayMathNode(typeof only.value === "string" ? only.value : "");
          }
        }
        visit(child);
        return child;
      });
    };

    visit(tree);
  };
}
