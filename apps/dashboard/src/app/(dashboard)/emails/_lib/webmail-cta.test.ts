import { describe, it, expect } from "vitest";

import { webmailCta } from "./webmail-cta";

const INSTALLED = { installed: true, url: "https://mail.example.com", projectId: "prj_1" };

describe("webmailCta", () => {
  it("links at the address when there is one", () => {
    expect(webmailCta(INSTALLED)).toEqual({ kind: "open", url: "https://mail.example.com" });
  });

  it("does not offer a deploy for a webmail that is already deployed", () => {
    // The regression this file exists for. The API degrades a webmail whose route rows
    // it could not read to `installed` + `routingUnknown` with no URL — deliberately, so
    // the install stays visible and its logs stay reachable. Reading that as "not
    // installed" put a Deploy button on a running webmail: not a wrong label but wrong
    // advice, since a redeploy has nothing to fix.
    const cta = webmailCta({ ...INSTALLED, url: "", routingUnknown: true });
    expect(cta).toEqual({ kind: "project", projectId: "prj_1" });
  });

  it("offers the deploy when nothing is installed", () => {
    expect(webmailCta({ installed: false, url: "" })).toEqual({ kind: "deploy" });
    expect(webmailCta(undefined)).toEqual({ kind: "deploy" });
  });

  it("offers the deploy for an out-of-band install with no project to open", () => {
    // Adopted, or installed before the webmail app: `installed` is true and there is no
    // project row. A project link would 404, and the deploy IS the remedy — it is how an
    // out-of-band webmail becomes a managed one.
    expect(webmailCta({ installed: true, url: "", routingUnknown: true, projectId: null })).toEqual(
      { kind: "deploy" },
    );
  });

  it("does not treat a missing routingUnknown as unknown routing", () => {
    // The field is optional because an older API doesn't send it, and absent has to mean
    // "routing is known" — the state every release before it was in. Otherwise an
    // unrouted-on-purpose webmail (no hostname, by choice) would stop offering a deploy.
    expect(webmailCta({ ...INSTALLED, url: "" })).toEqual({ kind: "deploy" });
  });
});
