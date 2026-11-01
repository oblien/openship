import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ScaleDetailsPanel } from "./ScaleDetailsPanel";

const actions = { onOpen: vi.fn(), onMinimize: vi.fn(), onClose: vi.fn() };

describe("on-demand scale settings", () => {
  it("shows an edit action without mounting settings on node selection", () => {
    const html = renderToStaticMarkup(
      <ScaleDetailsPanel title="Primary" kind="postgres" open={false} {...actions}>
        <div>Member settings content</div>
      </ScaleDetailsPanel>,
    );
    expect(html).toContain('aria-label="Expand settings for Primary"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Clear selection"');
    expect(html).toContain('hidden=""');
    expect(html).not.toContain("Member settings content");
  });

  it("mounts settings when opened explicitly", () => {
    const html = renderToStaticMarkup(
      <ScaleDetailsPanel title="Primary" kind="postgres" open {...actions}>
        <div>Member settings content</div>
      </ScaleDetailsPanel>,
    );
    expect(html).toContain("Member settings content");
    expect(html).not.toContain('aria-label="Expand settings for Primary"');
    expect(html).not.toContain('hidden=""');
  });
});
