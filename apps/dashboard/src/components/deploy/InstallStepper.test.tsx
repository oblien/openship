// Pure component (labels are passed in, no i18n) — renderToStaticMarkup, no DOM.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InstallStepper, type StepStatus } from "./InstallStepper";

function render(status: StepStatus, extra?: { children?: React.ReactNode }) {
  return renderToStaticMarkup(
    <InstallStepper steps={[{ id: "s", label: `Step ${status}`, status, children: extra?.children }]} />,
  );
}

describe("InstallStepper status → icon + token", () => {
  it("pending: a plain dim circle, no spinner", () => {
    const html = render("pending");
    expect(html).toContain("lucide-circle "); // plain Circle, not circle-check/minus/alert
    expect(html).toContain("text-muted-foreground/40");
    expect(html).not.toContain("animate-spin");
    expect(html).toContain("Step pending");
  });

  it("active: a spinning primary loader", () => {
    const html = render("active");
    expect(html).toContain("lucide-loader-circle");
    expect(html).toContain("animate-spin");
    expect(html).toContain("text-primary");
  });

  it("running behaves like active (shared superset status)", () => {
    const html = render("running");
    expect(html).toContain("lucide-loader-circle");
    expect(html).toContain("animate-spin");
  });

  it("done: a success check", () => {
    const html = render("done");
    expect(html).toContain("lucide-circle-check");
    expect(html).toContain("text-success");
  });

  it("skipped: a dim minus — dimmed, NOT active", () => {
    const html = render("skipped");
    expect(html).toContain("lucide-circle-minus");
    expect(html).toContain("text-muted-foreground/40");
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain("text-primary");
  });

  it("failed: a danger alert on icon and label", () => {
    const html = render("failed");
    expect(html).toContain("lucide-circle-alert");
    expect(html).toContain("text-danger");
  });

  it("uses only theme tokens, never hardcoded status colors", () => {
    for (const s of ["pending", "active", "done", "skipped", "failed"] as const) {
      const html = render(s);
      expect(html).not.toMatch(/emerald|amber|rose|\bred-\d|\bgreen-\d/);
    }
  });
});

describe("InstallStepper children (per-service sub-list)", () => {
  it("renders a sub-list indented under the row", () => {
    const html = render("active", {
      children: <span data-testid="svc">backend running</span>,
    });
    expect(html).toContain("backend running");
    expect(html).toContain("ml-[22px]"); // the indent wrapper only appears with children
  });

  it("omits the indent wrapper when there are no children", () => {
    expect(render("done")).not.toContain("ml-[22px]");
  });
});
