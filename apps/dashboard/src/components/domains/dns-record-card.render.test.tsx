// No DOM needed: renderToStaticMarkup runs no effects, and the card is pure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import DnsRecordCard from "./DnsRecordCard";

function render(record: React.ComponentProps<typeof DnsRecordCard>["record"]) {
  return renderToStaticMarkup(
    <I18nProvider>
      <DnsRecordCard record={record} />
    </I18nProvider>,
  );
}

/** Strip tags so assertions read against what the user actually sees. */
function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("DnsRecordCard", () => {
  it("labels every provider field and names the hostname the record is for", () => {
    const out = text(
      render({ type: "A", host: "freshs", name: "freshs.hekai.org", value: "65.109.55.23" }),
    );
    expect(out).toContain("Points freshs.hekai.org at this server");
    expect(out).toContain("Type");
    expect(out).toContain("Name");
    expect(out).toContain("Value");
    expect(out).toContain("TTL");
    expect(out).toContain("freshs");
    expect(out).toContain("65.109.55.23");
    // FQDN fallback for providers that reject the relative label.
    expect(out).toContain("Full name");
    expect(out).toContain("freshs.hekai.org");
    // A record ⇒ self-hosted ⇒ the cert is issued here, so no proxy in front.
    expect(out).toContain("DNS only");
  });

  it("explains an apex row instead of showing a bare @", () => {
    const out = text(render({ type: "A", host: "@", name: "hekai.org", value: "1.2.3.4" }));
    expect(out).toContain("is the domain itself");
  });

  it("says what a TXT record is for and never claims it needs a proxy off", () => {
    const out = text(
      render({
        type: "TXT",
        host: "_openship-challenge",
        name: "_openship-challenge.hekai.org",
        value: "abc123",
      }),
    );
    expect(out).toContain("Proves you own hekai.org");
    expect(out).not.toContain("DNS only");
  });

  it("distinguishes a www→apex alias from an edge CNAME", () => {
    const alias = text(
      render({ type: "CNAME", host: "www", name: "www.hekai.org", value: "hekai.org" }),
    );
    expect(alias).toContain("Points www.hekai.org at hekai.org");

    const edge = text(
      render({ type: "CNAME", host: "@", name: "hekai.org", value: "edge.openship.io" }),
    );
    expect(edge).toContain("through the edge network");
  });

  it("falls back to a placeholder when the server IP is unknown", () => {
    const out = text(render({ type: "A", host: "@", name: "hekai.org", value: "" }));
    expect(out).toContain("public IP");
  });
});
