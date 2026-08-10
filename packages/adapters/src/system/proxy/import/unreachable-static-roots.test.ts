import { describe, expect, test } from "vitest";
import { unreachableStaticRoots, copyStaticRootIntoEdge } from "./index";
import type { ImportedSite } from "../../types";
import type { CommandExecutor } from "../../../types";

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

/** Records every shell command so we can assert the exact mkdir/cp argv. */
function recordingExecutor(): { executor: CommandExecutor; commands: string[] } {
  const commands: string[] = [];
  const executor = {
    async exec(command: string) {
      commands.push(command);
      return "";
    },
  } as unknown as CommandExecutor;
  return { executor, commands };
}

describe("copyStaticRootIntoEdge", () => {
  test("copies the tree into the mounted static dir and returns the container-visible root", async () => {
    const { executor, commands } = recordingExecutor();
    const newRoot = await copyStaticRootIntoEdge(executor, {
      root: "/home/App.Front/dist/site/browser",
      host: "front.example.com",
    });
    // Dest is under the mounted static dir (host==container path) so the edge can read it.
    expect(newRoot).toBe("/opt/openship/static/_adopted/front.example.com");
    expect(commands).toEqual([
      "mkdir -p '/opt/openship/static/_adopted/front.example.com'",
      // `<src>/.` copies CONTENTS, so files land directly under <dest> matching `root <dest>;`.
      "cp -a '/home/App.Front/dist/site/browser/.' '/opt/openship/static/_adopted/front.example.com/'",
    ]);
  });

  test("sanitizes the hostname into the dest slug and strips a trailing slash from src", async () => {
    const { executor, commands } = recordingExecutor();
    const newRoot = await copyStaticRootIntoEdge(executor, {
      root: "/srv/My Site/dist/",
      host: "Weird_Host!!.example.com",
    });
    expect(newRoot).toBe("/opt/openship/static/_adopted/weird_host--.example.com");
    expect(commands[1]).toBe(
      "cp -a '/srv/My Site/dist/.' '/opt/openship/static/_adopted/weird_host--.example.com/'",
    );
  });
});
