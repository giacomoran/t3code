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
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

// The math toggle is the only setting these cases vary.
const mathEnabled = vi.hoisted(() => ({ current: true }));
vi.mock("../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useSettings")>()),
  getClientSettings: () => ({ wordWrap: true }),
  useClientSettings: (selector?: (settings: { chatMathEnabled: boolean }) => unknown) => {
    const settings = { chatMathEnabled: mathEnabled.current };
    return selector ? selector(settings) : settings;
  },
}));

import ChatMarkdown from "./ChatMarkdown";

function render(text: string, enabled: boolean): string {
  mathEnabled.current = enabled;
  return renderToStaticMarkup(<ChatMarkdown cwd={undefined} text={text} />);
}

describe("ChatMarkdown math rendering", () => {
  it("renders inline $...$ math through KaTeX", () => {
    const html = render("The cost is $O(n \\log n)$ overall.", true);

    // KaTeX markup survives the sanitize pass because it runs after it.
    expect(html).toContain("katex");
    expect(html).toContain("<annotation");
    expect(html).toContain("O(n \\log n)");
  });

  it("renders $$...$$ as display math", () => {
    const html = render("$$\\frac{1}{2}$$", true);

    expect(html).toContain("katex-display");
  });

  it("renders fenced $$ blocks as display math", () => {
    const html = render("$$\n\\frac{1}{2}\n$$", true);

    expect(html).toContain("katex-display");
  });

  it("renders \\( \\) inline math", () => {
    const html = render("The cost is \\(O(n \\log n)\\) overall.", true);

    expect(html).toContain("katex");
    expect(html).toContain("O(n \\log n)");
  });

  it("renders \\[ \\] as display math", () => {
    const html = render("\\[\\frac{1}{2}\\]", true);

    expect(html).toContain("katex-display");
  });

  it("leaves \\( \\) inside a code fence as code", () => {
    const html = render("```sh\necho \\(x\\)\n```", true);

    expect(html).not.toContain("katex");
    expect(html).toContain("echo");
  });

  it("leaves \\( \\) alone when math is disabled", () => {
    const html = render("The cost is \\(O(n)\\) overall.", false);

    expect(html).not.toContain("katex");
  });

  it("leaves dollar text untouched when math is disabled", () => {
    const html = render("The cost is $O(n \\log n)$ overall.", false);

    expect(html).not.toContain("katex");
    expect(html).toContain("$O(n");
  });

  it("still sanitizes author HTML while math is enabled", () => {
    const html = render("<img src=x onerror=alert(1)> and $x^2$", true);

    expect(html).not.toContain("onerror");
    expect(html).toContain("katex");
  });
});
