// No DOM needed: renderToStaticMarkup runs no effects, and the banner is pure.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HOST_CHANNEL_NOT_PROVISIONED, HOST_CHANNEL_UNPROVISIONED } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import {
  ConnectionBanner,
  classifyConnectionError,
  readConnectionDiagnosis,
} from "./connection-banner";

// The banner's "Edit server" button uses the app router; nothing here clicks it.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

function render(props: Partial<React.ComponentProps<typeof ConnectionBanner>> = {}) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ConnectionBanner
        serverId="s1"
        kind="host_channel"
        host="127.0.0.1"
        port={22}
        message="Timed out"
        retrying={false}
        onRetry={() => {}}
        {...props}
      />
    </I18nProvider>,
  );
}

function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const RULE = "sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp";

/**
 * #490: the whole point of this variant is that the row's `sshHost` (127.0.0.1)
 * names neither the right machine nor the right port, so the generic unreachable
 * copy sent operators to debug loopback SSH on the wrong host.
 */
describe("ConnectionBanner host_channel variant", () => {
  it("shows the dialed address instead of the row's loopback host", () => {
    const out = text(
      render({
        diagnosis: { target: "root@host.docker.internal:22", hint: null, rule: RULE },
      }),
    );
    expect(out).toContain("root@host.docker.internal:22");
    expect(out).not.toContain("127.0.0.1");
  });

  it("says deploys still work, and shows the rule to run on the host", () => {
    const out = text(render({ diagnosis: { target: "root@host.docker.internal:22", rule: RULE } }));
    expect(out).toContain("deploys to this box still work");
    expect(out).toContain(RULE);
  });

  // That this copy matches HOST_CHANNEL_* in @repo/core fact-for-fact is enforced in
  // src/i18n/host-channel-copy.test.ts — the string is translatable, so it can't be the
  // constant itself. Pinned here too because it is the symptom the operator is staring
  // at, and it must survive a re-word of the sentence around it.
  it("names the symptom the operator is looking at: this box reading Offline", () => {
    const out = text(render({ diagnosis: { target: "root@host.docker.internal:22", rule: RULE } }));
    expect(out).toContain('reads "Offline"');
  });

  it("does not show the misleading loopback checklist", () => {
    const out = text(render({ diagnosis: { target: "root@host.docker.internal:22", rule: RULE } }));
    // That checklist belongs to `unreachable`, where the host really is remote.
    expect(out).not.toContain("nc -zv");
    expect(out).not.toContain("ping ");
  });

  it("passes the API's own hint through verbatim", () => {
    const hint = "Nothing answered on host.docker.internal:22 from inside the container.";
    const out = text(render({ diagnosis: { target: "a@b:22", hint, rule: RULE } }));
    expect(out).toContain(hint);
  });

  it("still keeps the unreachable checklist for a genuinely remote host", () => {
    const out = text(render({ kind: "unreachable", host: "203.0.113.9", diagnosis: undefined }));
    expect(out).toContain("nc -zv 203.0.113.9 22");
    expect(out).not.toContain("deploys to this box still work");
  });
});

/**
 * #509: containerized with no OPENSHIP_HOST_SSH_HOST. There was no endpoint, so
 * nothing was contacted — and the banner used to fill the gap with the row's
 * display host, telling the operator that nothing answered on 127.0.0.1:22. The
 * remedy is `openship up`, not a firewall rule.
 */
const UNPROVISIONED_HINT = `${HOST_CHANNEL_UNPROVISIONED} ${HOST_CHANNEL_NOT_PROVISIONED}`;

describe("ConnectionBanner unprovisioned host channel", () => {
  it("names no machine when nothing was contacted", () => {
    const out = text(render({ diagnosis: { hint: UNPROVISIONED_HINT } }));
    expect(out).not.toContain("127.0.0.1");
    expect(out).not.toContain("Nothing answered");
    expect(out).toContain("never provisioned");
  });

  it("offers the provisioning command, never a firewall rule", () => {
    const out = text(render({ diagnosis: { hint: UNPROVISIONED_HINT } }));
    expect(out).toContain("provision the channel");
    expect(out).toContain("openship up");
    expect(out).not.toContain("ufw");
  });

  it("stays a degraded message: deploys still work, the box is not down", () => {
    const out = text(render({ diagnosis: { hint: UNPROVISIONED_HINT } }));
    expect(out).toContain("deploys to this box still work");
    expect(out).toContain("nothing here is down");
  });

  it("shows the address the channel WILL use as intent, not as a failed probe", () => {
    const out = text(
      render({
        diagnosis: {
          channel: "not_configured",
          intendedTarget: "root@host.docker.internal:22",
          hint: UNPROVISIONED_HINT,
        },
      }),
    );
    expect(out).toContain("Once provisioned the channel will reach the host at root@host.docker.internal:22");
    expect(out).toContain("Nothing has contacted that address");
    expect(out).not.toContain("Nothing answered");
  });

  // The trap this predicate exists for: a `target` on a not_configured channel is
  // the endpoint it WOULD use, so presenting it as dialed would move the
  // wrong-machine bug rather than fix it.
  it("ignores a target supplied alongside the not_configured code", () => {
    const out = text(
      render({
        diagnosis: {
          channel: "not_configured",
          target: "root@host.docker.internal:22",
          hint: UNPROVISIONED_HINT,
        },
      }),
    );
    expect(out).not.toContain("Nothing answered");
    expect(out).toContain("provision the channel");
  });

  it("keeps the dialed copy when the channel exists and was contacted", () => {
    const out = text(
      render({ diagnosis: { channel: "unreachable", target: "root@host.docker.internal:22", rule: RULE } }),
    );
    expect(out).toContain("Nothing answered there");
    expect(out).toContain(RULE);
    expect(out).not.toContain("openship up");
  });
});

describe("classifyConnectionError / readConnectionDiagnosis", () => {
  it("routes the API's host_channel_blocked code to its own copy", () => {
    expect(classifyConnectionError({ code: "host_channel_blocked" }, "Timed out")).toBe(
      "host_channel",
    );
  });

  it("leaves a real remote timeout on the unreachable path", () => {
    expect(classifyConnectionError({ code: "timeout" }, "Timed out")).toBe("unreachable");
  });

  it("reads a diagnosis only when the API actually attached one", () => {
    expect(readConnectionDiagnosis({ target: "a@b:22" })).toEqual({ target: "a@b:22" });
    expect(readConnectionDiagnosis({ error: "connection_failed" })).toBeUndefined();
    expect(readConnectionDiagnosis(null)).toBeUndefined();
  });

  it("carries the channel state and the intended endpoint through (#509)", () => {
    expect(
      readConnectionDiagnosis({ channel: "not_configured", intendedTarget: "root@h:22" }),
    ).toEqual({ channel: "not_configured", intendedTarget: "root@h:22" });
  });
});
