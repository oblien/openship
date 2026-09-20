import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectTransferCard } from "./DataTransferTab";

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("direct instance transfer UI", () => {
  it("presents one destination code instead of an encryption-key workflow", () => {
    const html = renderToStaticMarkup(<DirectTransferCard onToast={() => undefined} />);
    const output = text(html);

    expect(output).toContain("Move directly to another instance");
    expect(output).toContain("1. Receive on this instance");
    expect(output).toContain("Generate receive code");
    expect(output).toContain("2. Send from this instance");
    expect(output).toContain("Paste the destination code");
    expect(output).toContain("credentials are re-encrypted automatically");
    expect(output).not.toContain("BETTER_AUTH_SECRET");
  });

  it("starts with send disabled until a destination code is pasted", () => {
    const html = renderToStaticMarkup(<DirectTransferCard onToast={() => undefined} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(?:<svg[\s\S]*?<\/svg>)?[^<]*Move to destination/);
  });
});
