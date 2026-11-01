// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { code } from "@streamdown/code";

function render(text: string, streaming = false) {
  const element = document.createElement("div");
  element.innerHTML = renderToStaticMarkup(
    <AssistantMarkdown streaming={streaming}>{text}</AssistantMarkdown>,
  );
  return element;
}

describe("Assistant Markdown", () => {
  it("animates words only while streaming and keeps settled history free of animation wrappers", () => {
    const text = "Checking **your apps** now.";
    expect(render(text, true).querySelectorAll("[data-sd-animate]").length).toBeGreaterThan(0);
    expect(render(text, false).querySelectorAll("[data-sd-animate]").length).toBe(0);
    expect(render(text, true).textContent).toBe(render(text, false).textContent);
  });
  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });
  it.each([
    "javascript:alert(1)",
    "jav&#x61;script:alert(1)",
    "data:text/html,hello",
    "file:///etc/passwd",
    "blob:https://example.com/id",
    "vscode://file/private",
    "xmpp:user@example.com",
  ])("does not make %s actionable", (url) => {
    const element = render(`[Open this](${url})`);
    expect(element.querySelector("a[href]")).toBeNull();
    expect(element.textContent).toContain("Open this");
  });

  it.each([
    "/projects/web?tab=logs",
    "../projects/web",
    "#details",
    "https://example.com/docs",
    "//example.com/docs",
    "mailto:support@example.com",
  ])("preserves safe link %s without changing its destination", (url) => {
    const link = render(`[Open](${url})`).querySelector("a")!;
    expect(link.getAttribute("href")).toBe(url);
    if (/^(https?:)?\/\//.test(url)) {
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
    } else expect(link.target).toBe("");
  });

  it.each([
    "https://example.com/tracker",
    "/api/private/action",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  ])("never loads model image %s", (url) => {
    const element = render(`![Diagram](${url})`);
    expect(element.querySelector("img, iframe, object, embed, svg, video, audio")).toBeNull();
    expect(element.textContent).toBe("Diagram");
    expect(element.innerHTML).not.toContain(url);
  });

  it("keeps raw HTML inert in finished and unfinished replies", () => {
    const text =
      '<style>body{display:none}</style>\n\n<iframe src="https://example.com"></iframe>\n\n<form action="/api/delete"><input autofocus></form>\n\n<script>alert(1)</script>\n\n<img src="/api/private" onerror="alert(1)">';
    for (const streaming of [true, false]) {
      const element = render(text, streaming);
      expect(element.querySelector("style, script, form, input, iframe, img")).toBeNull();
      expect(element.querySelector("[onerror], [autofocus]")).toBeNull();
    }
  });

  it("renders tables, nested lists, tasks, quotes and inline code as Markdown", () => {
    const element = render(
      "## Deployment\n\n1. Check the app\n   - Read the logs\n\n- [x] Build completed\n- [ ] Review changes\n\n> No changes were made.\n\nUse `docker ps`.\n\n| App | State |\n| --- | --- |\n| API | Ready |",
    );
    expect(element.querySelector("h2")?.textContent).toBe("Deployment");
    expect(element.querySelector("ol li ul li")?.textContent).toBe("Read the logs");
    expect(
      [...element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((input) => [
        input.checked,
        input.disabled,
      ]),
    ).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(element.querySelector("blockquote")?.textContent).toContain("No changes were made.");
    expect(element.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe("docker ps");
    expect(element.querySelector("tbody td")?.textContent).toBe("API");
  });

  it("detects Arabic prose without reversing code", () => {
    const element = render(
      "## حالة التطبيق\n\nالتطبيق يعمل بصورة جيدة وجميع الخدمات متاحة.\n\n```sh\ndocker ps\n```",
    );
    expect(element.querySelector("h2")?.closest("[dir]")?.getAttribute("dir")).toBe("rtl");
    expect(element.querySelector('[data-streamdown="code-block"]')?.getAttribute("dir")).toBe(
      "ltr",
    );
  });

  it("keeps interrupted replies readable after reopening, with copy available", () => {
    expect(
      render("The app is **healthy").querySelector('[data-streamdown="strong"]')?.textContent,
    ).toBe("healthy");
    const element = render("```sh\ndocker ps");
    expect(element.querySelector("code")?.textContent).toBe("docker ps");
    expect(element.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')?.disabled).toBe(
      false,
    );
  });

  let root: Root | undefined;
  afterEach(async () => {
    if (root) await act(() => root!.unmount());
    root = undefined;
  });

  it("completes streamed formatting without replacing settled blocks or enabling copy early", async () => {
    // Load the real lazy highlighter before mounting to keep its callbacks inside act.
    await act(async () => {
      await new Promise<void>((resolve) => {
        const cached = code.highlight(
          { code: "docker ps", language: "sh", themes: code.getThemes() },
          () => resolve(),
        );
        if (cached) resolve();
      });
    });
    const element = document.createElement("div");
    root = createRoot(element);
    const show = async (text: string, streaming: boolean) => {
      await act(() =>
        root!.render(<AssistantMarkdown streaming={streaming}>{text}</AssistantMarkdown>),
      );
    };
    await show("## Status\n\nThe app is **healthy", true);
    expect(element.querySelector('[data-streamdown="strong"]')?.textContent).toBe("healthy");
    const heading = element.querySelector("h2");
    const source = "## Status\n\nThe app is **healthy**.\n\n```sh\ndocker ps";
    await show(source, true);
    expect(element.querySelector("h2")).toBe(heading);
    expect(element.querySelector("code")?.textContent).toBe("docker ps");
    expect(element.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')?.disabled).toBe(
      true,
    );
    await show(source + "\n```", false);
    expect(element.querySelector("h2")).toBe(heading);
    expect(element.querySelectorAll('[data-streamdown="code-block"]')).toHaveLength(1);
    expect(element.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')?.disabled).toBe(
      false,
    );
    expect(element.textContent).not.toContain("```");
  });
});
