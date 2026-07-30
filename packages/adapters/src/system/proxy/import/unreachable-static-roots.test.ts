import { describe, expect, test } from "vitest";
import { unreachableStaticRoots } from "./index";
import type { ImportedSite } from "../../types";

/**
 * A bare host proxy can serve any directory on the box; the containerized edge
 * only sees its bind mounts. Carrying `root /home/app/dist` across that boundary
 * produced a vhost answering 500 ("rewrite or internal redirection cycle while
 * internally redirecting to /index.html" — try_files with no index to find),
 * which reads as a broken site instead of a missing mount. Observed on a live
 * migration: 2 of 15 sites came up 500 for exactly this reason.
 */

const staticSite = (host: string, root: string): ImportedSite => ({
  serverNames: [host],
  ssl: true,
  target: { kind: "static", root },
});

const proxySite = (host: string, url: string): ImportedSite => ({
  serverNames: [host],
  ssl: true,
  target: { kind: "proxy", url },
});

describe("unreachableStaticRoots", () => {
  test("flags a host docroot the edge container has no mount for", () => {
    const sites = [
      staticSite("front.example.com", "/home/App.Front/dist/site/browser"),
      staticSite("stage.example.com", "/home/App.Stage/dist/site/browser"),
    ];
    expect(unreachableStaticRoots(sites, { containerEdge: true })).toEqual([
      { host: "front.example.com", root: "/home/App.Front/dist/site/browser" },
      { host: "stage.example.com", root: "/home/App.Stage/dist/site/browser" },
    ]);
  });

  test("accepts a docroot already under a mounted path", () => {
    const sites = [
      staticSite("ok.example.com", "/opt/openship/static/ok"),
      // The mount root itself, and a trailing slash, both count as inside.
      staticSite("root.example.com", "/opt/openship/static"),
      staticSite("slash.example.com", "/opt/openship/static/x/"),
    ];
    expect(unreachableStaticRoots(sites, { containerEdge: true })).toEqual([]);
  });

  test("matches on a path boundary, not a string prefix", () => {
    // `/opt/openship/staticstuff` is NOT inside `/opt/openship/static`.
    const sites = [staticSite("sneaky.example.com", "/opt/openship/staticstuff/dist")];
    expect(unreachableStaticRoots(sites, { containerEdge: true })).toEqual([
      { host: "sneaky.example.com", root: "/opt/openship/staticstuff/dist" },
    ]);
  });

  test("ignores proxy sites — only a docroot has to be readable by the edge", () => {
    const sites = [proxySite("api.example.com", "http://127.0.0.1:5002")];
    expect(unreachableStaticRoots(sites, { containerEdge: true })).toEqual([]);
  });

  test("a bare-host edge can read every path, so nothing is flagged", () => {
    const sites = [staticSite("front.example.com", "/home/App.Front/dist")];
    expect(unreachableStaticRoots(sites, { containerEdge: false })).toEqual([]);
  });
});
