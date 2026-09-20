import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformProvider, usePlatform } from "./PlatformContext";

function VersionProbe() {
  const { version } = usePlatform();
  return <span>{version ?? "unavailable"}</span>;
}

describe("PlatformProvider release version", () => {
  it("makes the server-provided release available to dashboard chrome", () => {
    const html = renderToStaticMarkup(
      <PlatformProvider version="0.6.9">
        <VersionProbe />
      </PlatformProvider>,
    );

    expect(html).toContain(">0.6.9<");
  });

  it("keeps the value optional for older servers", () => {
    const html = renderToStaticMarkup(
      <PlatformProvider>
        <VersionProbe />
      </PlatformProvider>,
    );

    expect(html).toContain(">unavailable<");
  });
});
