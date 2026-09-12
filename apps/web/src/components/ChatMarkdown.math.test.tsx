import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

// The math mode is the only setting these cases vary.
const mathMode = vi.hoisted(() => ({ current: "latex" as "off" | "latex" | "dollar" }));
vi.mock("../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useSettings")>()),
  getClientSettings: () => ({ wordWrap: true }),
  useClientSettings: (selector?: (settings: { chatMath: string }) => unknown) => {
    const settings = { chatMath: mathMode.current };
    return selector ? selector(settings) : settings;
  },
}));

import ChatMarkdown from "./ChatMarkdown";

function render(text: string, mode: "off" | "latex" | "dollar" = "latex"): string {
  mathMode.current = mode;
  return renderToStaticMarkup(<ChatMarkdown cwd={undefined} text={text} />);
}

describe("ChatMarkdown math rendering", () => {
  it("renders inline $...$ math only in dollar mode", () => {
    const html = render("The cost is $O(n \\log n)$ overall.", "dollar");

    // KaTeX markup survives the sanitize pass because it runs after it.
    expect(html).toContain("katex");
    expect(html).toContain("<annotation");
    expect(html).toContain("O(n \\log n)");
  });

  it("renders $$...$$ as display math", () => {
    const html = render("$$\\frac{1}{2}$$");

    expect(html).toContain("katex-display");
  });

  it("renders fenced $$ blocks as display math", () => {
    const html = render("$$\n\\frac{1}{2}\n$$");

    expect(html).toContain("katex-display");
  });

  it("renders \\( \\) inline math", () => {
    const html = render("The cost is \\(O(n \\log n)\\) overall.");

    expect(html).toContain("katex");
    expect(html).toContain("O(n \\log n)");
  });

  it("renders \\[ \\] as display math", () => {
    const html = render("\\[\\frac{1}{2}\\]");

    expect(html).toContain("katex-display");
  });

  it("leaves \\( \\) inside a code fence as code", () => {
    const html = render("```sh\necho \\(x\\)\n```");

    expect(html).not.toContain("katex");
    expect(html).toContain("echo");
  });

  it("leaves \\( \\) alone when math is disabled", () => {
    const html = render("The cost is \\(O(n)\\) overall.", "off");

    expect(html).not.toContain("katex");
  });

  it("leaves single dollars as text in the default mode", () => {
    const html = render("The cost is $O(n)$ overall.");

    expect(html).not.toContain("katex");
    expect(html).toContain("$O(n)$");
  });

  it("catches currency as math in dollar mode, which is why it is opt-in", () => {
    const html = render("roughly $1K to date. $1K spent.", "dollar");

    expect(html).toContain("katex");
  });

  it("leaves currency amounts in prose alone", () => {
    const html = render("roughly $1K to date, and we will cover it. $1K spent buying credibility.");

    expect(html).not.toContain("katex");
    expect(html).toContain("$1K to date");
  });

  it("leaves dollar text untouched when math is disabled", () => {
    const html = render("The cost is $O(n \\log n)$ overall.", "off");

    expect(html).not.toContain("katex");
    expect(html).toContain("$O(n");
  });

  it("still sanitizes author HTML while math is enabled", () => {
    const html = render("<img src=x onerror=alert(1)> and \\(x^2\\)");

    expect(html).not.toContain("onerror");
    expect(html).toContain("katex");
  });
});
