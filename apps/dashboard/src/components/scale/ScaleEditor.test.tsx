import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ScaleEditor from "./ScaleEditor";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./ScaleCanvas", () => ({ default: () => <div data-testid="scale-canvas" /> }));
vi.mock("@/components/toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./useTopologyStorage", () => ({
  useTopologyStorage: () => ({ ready: true, notice: "", blocked: false, retry: vi.fn() }),
}));

describe("canvas-first scale workspace", () => {
  it("uses the full available space and leaves the inspector unmounted until node selection", () => {
    const html = renderToStaticMarkup(<ScaleEditor storageKey="test-scale" />);
    expect(html).toContain('class="scale-page h-full min-h-0 w-full p-3"');
    expect(html).toContain('data-testid="scale-canvas"');
    expect(html).toContain('class="absolute inset-0" aria-label="Scaling topology"');
    expect(html.match(/<header/g)).toHaveLength(1);
    for (const removed of [
      "Save draft",
      "Edge gateways",
      "Data stores",
      "Plan overview",
      "scale-inspector-overlay",
      "max-w-[1600px]",
      "h-[640px]",
      "h-[720px]",
    ])
      expect(html).not.toContain(removed);
  });

  it("keeps the inspector out of the canvas layout at every breakpoint", () => {
    const stylesheet = parse(readFileSync(new URL("./scale.css", import.meta.url), "utf8"));
    const positions: string[] = [];
    stylesheet.walkRules(".scale-inspector-overlay", (rule) => {
      rule.walkDecls("position", (declaration) => {
        positions.push(declaration.value);
      });
    });
    expect(positions).toEqual(["absolute"]);
  });
});
import { readFileSync } from "node:fs";
import { parse } from "postcss";
