import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveServiceLogsTerminal } from "./LiveServiceLogsTerminal";

function render(active: boolean) {
  return renderToStaticMarkup(
    <LiveServiceLogsTerminal
      projectId="project-1"
      serviceId="service-1"
      active={active}
      theme="dark"
    />,
  );
}

describe("LiveServiceLogsTerminal visibility", () => {
  it("removes an inactive service terminal from painting and hit testing", () => {
    const html = render(false);

    expect(html).toContain("visibility:hidden");
    expect(html).toContain("pointer-events:none");
    expect(html).toContain('aria-hidden="true"');
  });

  it("shows only the active service terminal", () => {
    const html = render(true);

    expect(html).toContain("visibility:visible");
    expect(html).toContain("pointer-events:auto");
    expect(html).toContain('aria-hidden="false"');
  });
});
