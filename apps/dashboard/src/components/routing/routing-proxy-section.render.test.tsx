// No DOM needed: renderToStaticMarkup runs no effects, so this pins the markup the
// section renders for a given config — including discoverable groups and human labels.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PROXY_DIRECTIVES, type RoutingConfig } from "@repo/core";
import type { EdgeConfigReport } from "@/lib/api/projects";
import { I18nProvider } from "@/components/i18n-provider";
import { RoutingConfigEditor } from "./RoutingConfigEditor";

/**
 * The proxy-tunables section exists because OpenResty inherits nginx's defaults, so
 * an upload over 1 MB is a 413 and anything slower than 60s is cut off — and because
 * "what we saved" and "what the edge serves" can differ without anything saying so.
 *
 * Properties worth pinning: it must NOT appear in the deploy wizard; every group must remain visible; every directive in the table must reach
 * the UI without a code change here; and the live column must never report "not set"
 * for a value the box is actually serving.
 */
function render(
  value: RoutingConfig | null,
  showProxySettings = false,
  edgeConfig?: EdgeConfigReport | null,
) {
  return renderToStaticMarkup(
    <I18nProvider>
      <RoutingConfigEditor
        value={value}
        onChange={() => {}}
        showProxySettings={showProxySettings}
        edgeConfig={edgeConfig}
      />
    </I18nProvider>,
  );
}

/** An edge report with one host serving `live` for `key`. */
function report(
  directives: EdgeConfigReport["hosts"][number]["directives"],
  extra?: Partial<EdgeConfigReport>,
): EdgeConfigReport {
  return {
    reachable: true,
    proxyKind: "openresty",
    ours: true,
    saved: {},
    hosts: [
      {
        hostname: "app.example.com",
        found: true,
        tls: true,
        directives,
        adoptable: {},
        driftCount: directives.filter((d) => d.drift).length,
      },
    ],
    ...extra,
  };
}

describe("RoutingConfigEditor proxy-tunables section", () => {
  it("is absent unless the caller asks for it (keeps it out of the deploy wizard)", () => {
    const html = render(null);
    expect(html).not.toContain("Proxy settings");
    expect(html).not.toContain("client_max_body_size");
  });

  it("renders its header and a description on the project tab", () => {
    const html = render(null, true);
    expect(html).toContain("Proxy settings");
    expect(html).toContain("Upload size, timeouts");
  });

  it("names the defaults it is overriding, so an empty box isn't ambiguous", () => {
    // "Empty" has to read as "nginx's default applies", not "no limit".
    const html = render(null, true);
    expect(html).toContain("1 MB");
    expect(html).toContain("60s");
  });

  it("shows all settings even when nothing is set", () => {
    // Empty defaults must not hide the available controls.
    expect(render(null, true)).toContain("client_max_body_size");
  });

  it("shows the stored value when a limit is configured", () => {
    const html = render({ proxy: { clientMaxBodySize: "50m" } }, true);
    expect(html).toContain('value="50m"');
    expect(html).toContain("client_max_body_size");
  });

  it("offers the timeouts alongside the size — raising the size alone won't fix a big upload", () => {
    const html = render({ proxy: { clientMaxBodySize: "50m" } }, true);
    for (const label of ["Read timeout", "Send timeout", "Upload timeout"]) {
      expect(html).toContain(label);
    }
  });

  it("renders every directive in the table, so a new row needs no change here", () => {
    // The whole point of PROXY_DIRECTIVES: one row adds a validated, rendered,
    // parsed-back AND editable directive. A field that never reaches the UI is a
    // setting an operator can't use.
    const html = render({ proxy: { clientMaxBodySize: "50m" } }, true);
    for (const spec of PROXY_DIRECTIVES) expect(html).toContain(spec.directive);
  });

  it("groups the fields, so 23 directives don't read as one flat wall", () => {
    const html = render({ proxy: { clientMaxBodySize: "50m" } }, true);
    for (const group of ["Uploads", "Timeouts", "Response buffering", "Compression"]) {
      expect(html).toContain(group);
    }
  });

  it("offers three states for a boolean, because nginx has three", () => {
    // A checkbox can express on/off but not "unset, inherit nginx's default" — and
    // once a value is stored, being unable to clear it is a one-way door.
    const html = render({ proxy: { gzip: true } }, true);
    expect(html).toContain("Use server default");
    expect(html).toContain("Enabled");
  });

  it("does not claim buffering is on when nothing was chosen", () => {
    // The old checkbox rendered unset as checked, so an unset project looked like it
    // had explicitly opted into buffering.
    const html = render({ proxy: { clientMaxBodySize: "50m" } }, true);
    expect(html).not.toContain(">Enabled<");
  });

  it("shows a cleared field as empty rather than echoing a default into it", () => {
    // An empty box means "nginx's default applies". Pre-filling it with 60s would
    // make the next save persist a value the operator never chose.
    const html = render({ proxy: { clientMaxBodySize: "50m" } }, true);
    expect(html).toContain('value=""');
  });

  /* ── Live read-back ─────────────────────────────────────────────────────── */

  it("shows the live value beside the saved one", () => {
    const html = render(
      { proxy: { clientMaxBodySize: "50m" } },
      true,
      report([
        {
          key: "clientMaxBodySize",
          directive: "client_max_body_size",
          group: "body",
          expected: "50m",
          live: "50m",
          liveRaw: "50m",
          drift: false,
        },
      ]),
    );
    expect(html).toContain("Serving:");
    expect(html).toContain("app.example.com");
  });

  it("flags drift and offers to adopt what the box is serving", () => {
    const html = render({ proxy: { clientMaxBodySize: "50m" } }, true, {
      ...report([
        {
          key: "clientMaxBodySize",
          directive: "client_max_body_size",
          group: "body",
          expected: "50m",
          live: "1m",
          liveRaw: "1m",
          drift: true,
        },
      ]),
      hosts: [
        {
          hostname: "app.example.com",
          found: true,
          tls: true,
          directives: [
            {
              key: "clientMaxBodySize",
              directive: "client_max_body_size",
              group: "body",
              expected: "50m",
              live: "1m",
              liveRaw: "1m",
              drift: true,
            },
          ],
          adoptable: { clientMaxBodySize: "1m" },
          driftCount: 1,
        },
      ],
    });
    expect(html).toContain("The edge is serving different values for:");
    expect(html).toContain("Adopt live values");
  });

  it("shows drift even with nothing saved", () => {
    // Drift with no saved value is the interesting case — someone edited the vhost by
    // hand, and the next save will overwrite it.
    const html = render(
      null,
      true,
      report([
        {
          key: "clientMaxBodySize",
          directive: "client_max_body_size",
          group: "body",
          live: "1m",
          liveRaw: "1m",
          drift: true,
        },
      ]),
    );
    expect(html).toContain("client_max_body_size");
  });

  it("displays a live value our own validators would reject", () => {
    // A hand-written vhost may hold `20M` or `1d`. Reporting "not set" for a limit
    // that is very much set is the one lie this panel must not tell.
    const html = render(
      null,
      true,
      report([
        {
          key: "clientMaxBodySize",
          directive: "client_max_body_size",
          group: "body",
          liveRaw: "20M",
          drift: true,
        },
      ]),
    );
    expect(html).toContain("20M");
    expect(html).not.toContain("Serving: not set");
  });

  it("says the live config was unreadable instead of implying agreement", () => {
    const html = render({ proxy: { clientMaxBodySize: "50m" } }, true, {
      reachable: false,
      saved: {},
      hosts: [],
    });
    // Apostrophe is HTML-escaped in static markup, so match around it.
    expect(html).toContain("t read the live config");
    expect(html).not.toContain("The edge is serving different values for:");
  });

  it("reports no drift when the box matches", () => {
    const html = render(
      { proxy: { clientMaxBodySize: "50m" } },
      true,
      report([
        {
          key: "clientMaxBodySize",
          directive: "client_max_body_size",
          group: "body",
          expected: "50m",
          live: "50m",
          liveRaw: "50m",
          drift: false,
        },
      ]),
    );
    expect(html).not.toContain("The edge is serving different values for:");
    expect(html).not.toContain("Adopt live values");
  });
});
