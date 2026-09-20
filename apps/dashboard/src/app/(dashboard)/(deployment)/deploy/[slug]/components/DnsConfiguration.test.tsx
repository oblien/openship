import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/components/i18n-provider";
import DnsConfiguration from "./DnsConfiguration";

vi.mock("@/lib/api", () => ({
  domainsApi: {
    dnsPlan: vi.fn(),
    dnsApply: vi.fn(),
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

describe("DnsConfiguration", () => {
  it("offers the shared DNS plan/apply workflow for a persisted service domain", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <DnsConfiguration
          domain="api.example.com"
          domainId="dom_service"
          mode="selfhosted"
          records={[
            {
              type: "A",
              host: "api",
              name: "api.example.com",
              value: "203.0.113.10",
            },
          ]}
        />
      </I18nProvider>,
    );

    const out = text(html);
    expect(out).toContain("Checking your DNS provider");
    expect(out).toContain("api.example.com");
    expect(out).toContain("203.0.113.10");
  });

  it("keeps an unpersisted pre-deploy preview read-only", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <DnsConfiguration
          domain="api.example.com"
          mode="selfhosted"
          records={[
            {
              type: "A",
              host: "api",
              name: "api.example.com",
              value: "203.0.113.10",
            },
          ]}
        />
      </I18nProvider>,
    );

    expect(text(html)).not.toContain("Checking your DNS provider");
  });
});
