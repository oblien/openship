import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/components/i18n-provider";
import DnsRecordsModal from "./DnsRecordsModal";

vi.mock("@/lib/api", () => ({
  domainsApi: {
    records: vi.fn(),
    previewRecords: vi.fn(),
  },
}));

function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

describe("DnsRecordsModal", () => {
  it("names every Docker service domain and clearly asks for DNS before deploy", () => {
    const out = text(renderToStaticMarkup(
      <I18nProvider>
        <DnsRecordsModal
          targets={[
            { hostname: "web.example.com" },
            { hostname: "admin.example.com" },
          ]}
          serverId="server_remote"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    ));

    expect(out).toContain("DNS Configuration");
    expect(out).toContain("web.example.com, admin.example.com");
    expect(out).toContain("HTTPS is issued on the first deploy once your domain points here");
    expect(out).toContain("Deploy");
    expect(out).toContain("Cancel");
  });

  it("renders a custom confirmLabel when provided", () => {
    const out = text(renderToStaticMarkup(
      <I18nProvider>
        <DnsRecordsModal
          targets={[{ hostname: "app.example.com" }]}
          confirmLabel="Install"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    ));

    expect(out).toContain("Install");
    expect(out).not.toContain("Deploy");
  });
});
