import { app, net, protocol } from "electron";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { downloadUpdate } from "../../src/main/updater";
import { fetchUpdateAsset } from "../../src/main/update-download";

// Only the updater is loaded. This process has its own profile and downloads,
// no application windows, no API, and no access to the user's Openship state.
const directory = process.argv.at(-1)!;
const downloads = join(directory, "downloads");
mkdirSync(downloads);
app.setName("Openship updater regression test");
app.setPath("userData", join(directory, "profile"));
app.setPath("temp", downloads);
app.commandLine.appendSwitch("disable-gpu");

const version = "9.8.7";
const name = "Openship.AppImage";
const url = `https://github.com/oblien/openship/releases/download/v${version}/${name}`;
const asset = { name, url, size: readFileSync(join(directory, name)).length };
const cdn = "https://release-assets.githubusercontent.com";
let mode = "success";
let invalidTarget = "https://untrusted.example/installer";
let badSuffix = "";
const seen: string[] = [];

async function run() {
  await app.whenReady();
  app.dock?.hide();
  // The real Chromium request/redirect/stream machinery runs against fixture
  // responses. No internet access or changes to the production allowlist.
  protocol.handle("https", async request => {
    seen.push(request.url);
    const scenario = mode;
    const target = new URL(request.url);
    if (scenario === "loop") return new Response(null, { status: 302, headers: { location: request.url } });
    if (scenario === "relative") return target.pathname === "/first"
      ? new Response(null, { status: 307, headers: { location: "/last" } })
      : new Response("relative redirect");
    if (scenario === "waiting") await new Promise(resolve => setTimeout(resolve, 100));
    if (scenario === "streaming") return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    }));
    const filename = target.pathname.split("/").at(-1)!;
    if (target.hostname === "github.com") {
      const destination = scenario === "untrusted" && filename === name + badSuffix
        ? invalidTarget : `${cdn}/${filename}`;
      return new Response(null, { status: 302, headers: { location: destination } });
    }
    assert.equal(target.hostname, "release-assets.githubusercontent.com", "untrusted host was contacted");
    if (scenario === "missing") return new Response("missing", { status: 404 });
    return new Response(readFileSync(join(directory, filename)));
  });

  // Demonstrate the Electron behavior that the old mocked fetch tests missed.
  await assert.rejects(net.fetch(url, { redirect: "manual" }), /Redirect was cancelled/);
  seen.length = 0;

  const progress: number[] = [];
  const file = await downloadUpdate(asset, version, fraction => progress.push(fraction));
  assert.deepEqual(readFileSync(file), readFileSync(join(directory, name)));
  assert.equal(progress.at(-1), 1);
  for (const suffix of ["", ".sha256", ".sig"]) {
    assert.ok(seen.includes(url + suffix));
    assert.ok(seen.includes(`${cdn}/${name}${suffix}`));
  }
  const retained = readdirSync(downloads);

  mode = "untrusted";
  for (const [suffix, error] of [["", /Untrusted/], [".sha256", /integrity/], [".sig", /signature/]] as const) {
    badSuffix = suffix;
    seen.length = 0;
    await assert.rejects(downloadUpdate(asset, version, () => {}), error);
    assert.ok(!seen.includes(invalidTarget));
    assert.deepEqual(readdirSync(downloads), retained, "failed download was left behind");
  }
  badSuffix = "";
  for (const destination of ["http://github.com/installer", "https://github.com.evil.example/installer", "https://github.com:8443/installer"]) {
    invalidTarget = destination;
    seen.length = 0;
    await assert.rejects(fetchUpdateAsset(url, AbortSignal.timeout(2_000)), /Untrusted/);
    assert.deepEqual(seen, [url]);
  }

  mode = "relative";
  assert.equal(await (await fetchUpdateAsset(`${cdn}/first`, AbortSignal.timeout(2_000))).text(), "relative redirect");
  mode = "loop";
  seen.length = 0;
  await assert.rejects(fetchUpdateAsset(url, AbortSignal.timeout(2_000)), /Too many update redirects/);
  assert.equal(seen.length, 6);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error("cancelled before download"));
  seen.length = 0;
  await assert.rejects(fetchUpdateAsset(url, alreadyAborted.signal), /cancelled before download/);
  assert.deepEqual(seen, []);
  mode = "waiting";
  await assert.rejects(fetchUpdateAsset(`${url}?waiting`, AbortSignal.timeout(10)), { name: "TimeoutError" });
  mode = "streaming";
  const active = new AbortController();
  const response = await fetchUpdateAsset(url, active.signal);
  const reader = response.body!.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
  active.abort(new Error("cancelled during download"));
  await assert.rejects(reader.read(), /cancelled during download/);

  mode = "missing";
  await assert.rejects(downloadUpdate(asset, version, () => {}), /Download failed: HTTP 404/);
  assert.deepEqual(readdirSync(downloads), retained);
  console.log("Electron updater regression checks passed");
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
