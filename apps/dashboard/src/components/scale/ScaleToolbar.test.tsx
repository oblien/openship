import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ResourceMenu, ScaleToolbar } from "./ScaleToolbar";

describe("scaling toolbar", () => {
  it("keeps only canvas actions visible, without metrics or a save button", () => {
    const html = renderToStaticMarkup(
      <ScaleToolbar
        canUndo={false}
        canRedo={false}
        canAdd
        hasNodes
        onAdd={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onLayout={vi.fn()}
        onExport={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(html).toContain('aria-label="Add node"');
    expect(html).toContain('aria-label="Undo"');
    expect(html).toContain('aria-label="Redo"');
    expect(html).toContain('aria-label="Canvas options"');
    expect(html).toContain('aria-label="Auto layout"');
    expect(html).toContain('aria-label="Edit topology"');
    expect(html).toContain('aria-keyshortcuts="Control+Z Meta+Z"');
    expect(html).toContain("scale-toolbar absolute");
    expect(html.match(/scale-floating-surface/g)).toHaveLength(2);
    expect(html).not.toContain("border-b ");
    expect(html).not.toContain("justify-between");
    for (const label of [
      "Save draft",
      "Edge gateways",
      "Applications",
      "Instances",
      "Data stores",
      "Export topology",
      "Reset example",
    ])
      expect(html).not.toContain(label);
  });

  it("lists database engines before presenting deployment choices", () => {
    const html = renderToStaticMarkup(<ResourceMenu onAdd={vi.fn()} />);
    const databaseGroup = html.slice(html.indexOf('role="group" aria-label="Databases"'));
    expect(html).toContain("OpenShip Edge");
    expect(html).toContain("Application");
    expect(databaseGroup).toContain('aria-label="Choose PostgreSQL deployment"');
    expect(databaseGroup).toContain('aria-label="Choose Redis deployment"');
    expect(databaseGroup).not.toContain("Standalone");
    expect(databaseGroup).not.toContain("Add PostgreSQL cluster");
    expect(databaseGroup).not.toContain("Application");
    expect(html.match(/data-kind=/g)).toHaveLength(4);
  });
});
