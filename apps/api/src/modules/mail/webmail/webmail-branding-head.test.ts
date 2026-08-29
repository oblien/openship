/**
 * Branding must reach the webmail document <head>.
 *
 * GH-568: `siteTitle` and `siteDescription` were accepted by
 * `PATCH /admin/branding`, persisted, and echoed by `/branding.json` - yet the
 * served page still said "OpenShip Mail", because the SPA is prebuilt and both
 * values are frozen into `client/build/client/index.html`. The fix substitutes
 * them server-side (apps/email/server/src/lib/index-html.ts) rather than in the
 * browser, because the issue also asks for correct OpenGraph tags and
 * link-preview crawlers do not execute JavaScript.
 *
 * The failure mode that matters is a SILENT no-op - a substitution that stops
 * matching and reports success - so these tests pin the two things that make it
 * silent: the tag patterns, and the `missing` report that surfaces a template
 * whose <head> changed shape.
 *
 * Why this test lives in apps/api rather than next to the code: the root
 * package.json runs `turbo run test --filter=!@repo/email`, and apps/email
 * declares no test script at all, so anything under apps/email/**\/test is
 * never executed by CI. Its siblings webmail-catalog-contract.test.ts and
 * webmail-client-origin.test.ts are here for the same reason. The import below
 * reaches across app boundaries deliberately: `injectBranding` is pure - no
 * env, no filesystem, no module state - specifically so it can be imported
 * from a runner that CI actually runs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { injectBranding, escapeHtml } from "../../../../../email/server/src/lib/index-html";

/** The emitted <head>, trimmed to the tags under test. */
const HEAD = [
  "<head>",
  '<meta charSet="utf-8"/>',
  '<link rel="manifest" href="/manifest.json"/>',
  "<title>OpenShip Mail</title>",
  '<meta name="description" content="Your self-hosted mailbox."/>',
  '<meta property="og:title" content="OpenShip Mail"/>',
  '<meta property="og:description" content="Your self-hosted mailbox."/>',
  '<meta property="og:image" content="/og.png"/>',
  "</head>",
].join("");

function clientFile(...parts: string[]): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "apps", "email", "client");
    try {
      readFileSync(join(candidate, "react-router.config.ts"));
      return readFileSync(join(candidate, ...parts), "utf-8");
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("apps/email/client not found - fix the marker walk in this test");
}

const BRANDED = { siteTitle: "Contribute Club eMail", siteDescription: "Mail Server for CC" };

describe("webmail branding head (GH-568)", () => {
  it("substitutes every branded slot", () => {
    const { html, missing } = injectBranding(HEAD, BRANDED);

    expect(missing).toEqual([]);
    expect(html).toContain("<title>Contribute Club eMail</title>");
    expect(html).toContain('<meta name="description" content="Mail Server for CC"/>');
    expect(html).toContain('<meta property="og:title" content="Contribute Club eMail"/>');
    expect(html).toContain('<meta property="og:description" content="Mail Server for CC"/>');
    // The default must be gone, not merely accompanied.
    expect(html).not.toContain("OpenShip Mail");
    expect(html).not.toContain("Your self-hosted mailbox.");
  });

  it("leaves tags it does not own alone", () => {
    const { html } = injectBranding(HEAD, BRANDED);
    expect(html).toContain('<meta property="og:image" content="/og.png"/>');
    expect(html).toContain('<meta charSet="utf-8"/>');
    expect(html).toContain('<link rel="manifest" href="/manifest.json"/>');
  });

  it("escapes operator input instead of injecting markup", () => {
    // The PATCH token bounds who can set this, not what it may do. A title is
    // interpolated into both element text and an attribute value, so a `<` or a
    // `"` must not be able to break out of either.
    const { html } = injectBranding(HEAD, {
      siteTitle: 'Acme "Mail" </title><script>alert(1)</script>',
      siteDescription: "a & b",
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;Mail&quot;");
    expect(html).toContain('content="a &amp; b"');
    // Exactly one title element - the payload did not close it early.
    expect(html.match(/<\/title>/g)).toHaveLength(1);
  });

  it("reports slots it could not find rather than passing silently", () => {
    // A future client build that drops or renames a tag must be loud. Silence
    // here is the original bug.
    const { missing } = injectBranding("<title>x</title>", BRANDED);
    expect(missing).toEqual(["description", "og:title", "og:description", "embed"]);
  });

  it("matches regardless of attribute order", () => {
    // React's emitted attribute order is not a contract.
    const reordered = '<meta content="Your self-hosted mailbox." name="description"/>';
    const { html, missing } = injectBranding(`<title>t</title>${reordered}`, BRANDED);
    expect(missing).toEqual(["og:title", "og:description", "embed"]);
    expect(html).toContain("Mail Server for CC");
  });

  it("escapeHtml covers the five markup-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    // Ampersand first, or the other escapes get double-escaped.
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

/**
 * The half that makes the fix stick. Substituting the head is not enough on its
 * own: the SPA hydrates the whole document, so if the client's first render
 * disagrees with the server, React rewrites <title> and appends duplicate metas
 * - the tab reverted to "OpenShip Mail" moments after load. The server
 * therefore embeds what it rendered and the client reads it back.
 */
describe("webmail branding hydration agreement (GH-568)", () => {
  it("embeds the branding the client hydrates from", () => {
    const { html, missing } = injectBranding(HEAD, {
      ...BRANDED,
      showPoweredBy: false,
    } as never);

    expect(missing).toEqual([]);
    const json = html.match(
      /<script id="__branding__" type="application\/json">([\s\S]*?)<\/script>/,
    )?.[1];
    expect(json, "no __branding__ payload - the client would revert to build-time defaults").toBeTruthy();
    const parsed = JSON.parse(json!);
    expect(parsed.siteTitle).toBe(BRANDED.siteTitle);
    expect(parsed.showPoweredBy).toBe(false);
    // Inside <head>, so it is parsed before the app's own scripts run.
    expect(html.indexOf('id="__branding__"')).toBeLessThan(html.indexOf("</head>"));
  });

  it("the embedded payload cannot break out of its script block", () => {
    // application/json is inert, but the TEXT still has to be escaped or a
    // `</script>` in an operator string ends the block early.
    const { html } = injectBranding(HEAD, {
      siteTitle: "Acme </script><img src=x onerror=alert(1)>",
      siteDescription: "d",
    });
    expect(html).not.toContain("</script><img");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    const json = html.match(
      /<script id="__branding__" type="application\/json">([\s\S]*?)<\/script>/,
    )![1];
    // Escaped for HTML, still valid JSON.
    expect(json).not.toContain("<");
    expect(JSON.parse(json).siteTitle).toBe("Acme </script><img src=x onerror=alert(1)>");
  });

  it("reports a template with no </head> instead of dropping the payload", () => {
    const { missing } = injectBranding("<title>t</title>", BRANDED);
    expect(missing).toContain("embed");
  });

  it("root.tsx builds its meta from the document, never from build-time constants", () => {
    // The precise regression: `{ title: siteConfig.title }` in the meta export
    // is what overwrote the server's value. og:image may stay - it is a
    // relative path, not branding.
    const root = clientFile("app", "root.tsx");
    const meta = root.slice(root.indexOf("export const meta"), root.indexOf("export function Layout"));

    expect(meta).toContain("runtimeBranding()");
    expect(meta).not.toContain("siteConfig.title");
    expect(meta).not.toContain("siteConfig.description");
  });
});
