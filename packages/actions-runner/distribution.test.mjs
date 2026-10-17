import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { installRunnerArtifact, validateRunnerArtifact } from "./distribution.mjs";
import {
  runnerFingerprint,
  RUNNER_ASSET_NAMES,
  RUNNER_TARGETS,
  verifyRunnerAssets,
} from "./assets.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "openship-worker-artifact-"));
  const dist = join(root, "payload/dist");
  mkdirSync(dist, { recursive: true });
  const files = {};
  for (const [os, arch] of RUNNER_TARGETS) {
    const name = `openship-actions-${os}-${arch}`;
    const contents = `fixture-worker:${os}/${arch}`;
    writeFileSync(join(dist, name), contents);
    files[`${os}/${arch}`] = { name, sha256: digest(contents).slice(7) };
  }
  writeFileSync(
    join(dist, "manifest.json"),
    JSON.stringify({
      protocol: 1,
      engine: "act/0.2.89",
      source: runnerFingerprint(),
      files,
      ...overrides,
    }),
  );
  writeFileSync(join(dist, "THIRD_PARTY_NOTICES.txt"), "nektos/act (MIT)");
  writeFileSync(join(root, "payload/do-not-extract"), "unrelated file");
  const archive = join(root, "layer.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", join(root, "payload"), "dist", "do-not-extract"]);
  const layer = readFileSync(archive);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      layers: [
        {
          mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
          size: layer.length,
          digest: digest(layer),
        },
      ],
    }),
  );
  const descriptor = {
    schemaVersion: 1,
    source: runnerFingerprint(),
    image: `ghcr.io/oblien/openship-actions-runner@${digest(manifest)}`,
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), headers: options?.headers });
    if (String(url).includes("/manifests/")) return new Response(manifest);
    if (String(url).includes("/blobs/")) return new Response(layer);
    throw new Error("Unexpected registry URL");
  };
  return {
    root,
    dist,
    layer,
    manifest,
    descriptor,
    calls,
    fetchImpl,
    destination: join(root, "installed"),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
const install = (f, options = {}) =>
  installRunnerArtifact(f.descriptor, f.destination, {
    verify: verifyRunnerAssets,
    names: RUNNER_ASSET_NAMES,
    fetchImpl: f.fetchImpl,
    ...options,
  });

test("installs the same four verified workers for Desktop, CLI and API without executing them", async () => {
  const f = fixture();
  try {
    await install(f);
    assert.deepEqual(verifyRunnerAssets(f.destination), verifyRunnerAssets(f.dist));
    for (const name of RUNNER_ASSET_NAMES)
      assert.deepEqual(readFileSync(join(f.destination, name)), readFileSync(join(f.dist, name)));
    assert.throws(() => readFileSync(join(f.root, "do-not-extract")), /ENOENT/);
    assert.equal(f.calls.length, 2);
  } finally {
    f.close();
  }
});

test("a cold install needs only tar on PATH, with no external gzip, Go or Docker", () => {
  const f = fixture();
  try {
    const tools = join(f.root, "tools");
    mkdirSync(tools);
    symlinkSync(execFileSync("which", ["tar"], { encoding: "utf8" }).trim(), join(tools, "tar"));
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { readFileSync } from "node:fs";
         import { installRunnerArtifact } from ${JSON.stringify(new URL("./distribution.mjs", import.meta.url).href)};
         import { verifyRunnerAssets, RUNNER_ASSET_NAMES } from ${JSON.stringify(new URL("./assets.mjs", import.meta.url).href)};
         await installRunnerArtifact(${JSON.stringify(f.descriptor)}, ${JSON.stringify(f.destination)}, {
           names: RUNNER_ASSET_NAMES,
           verify: verifyRunnerAssets,
           fetchImpl: async url => new Response(String(url).includes("/manifests/")
             ? ${JSON.stringify(f.manifest.toString())}
             : readFileSync(${JSON.stringify(join(f.root, "layer.tar.gz"))}))
         });`,
      ],
      { env: { ...process.env, PATH: tools }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(verifyRunnerAssets(f.destination), verifyRunnerAssets(f.dist));
  } finally {
    f.close();
  }
});

test("uses only anonymous, repository-scoped GHCR authentication", async () => {
  const f = fixture();
  const calls = [];
  try {
    await install(f, {
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), headers: options?.headers });
        if (String(url).startsWith("https://ghcr.io/token?"))
          return Response.json({ token: "public-pull-token" });
        if (!options.headers.Authorization)
          return new Response("", {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:oblien/openship-actions-runner:pull"',
            },
          });
        assert.equal(options.headers.Authorization, "Bearer public-pull-token");
        return f.fetchImpl(url, options);
      },
    });
    assert.equal(calls.length, 4);
    assert.equal(calls[1].headers, undefined);
  } finally {
    f.close();
  }
});

test("rejects an authentication challenge that would send credentials to another host", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      install(f, {
        fetchImpl: async () =>
          new Response("", {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer realm="https://evil.example/token",service="ghcr.io",scope="repository:oblien/openship-actions-runner:pull"',
            },
          }),
      }),
      /authentication challenge/,
    );
  } finally {
    f.close();
  }
});

test("rejects altered image metadata before downloading any worker", async () => {
  const f = fixture();
  try {
    await assert.rejects(install(f, { fetchImpl: async () => new Response("{}") }), /image digest/);
  } finally {
    f.close();
  }
});

test("rejects truncated or corrupted archive bytes and preserves the installed copy", async () => {
  const f = fixture();
  mkdirSync(f.destination);
  writeFileSync(join(f.destination, "previous"), "keep");
  try {
    for (const bad of [f.layer.subarray(0, -1), Buffer.alloc(f.layer.length)]) {
      await assert.rejects(
        install(f, {
          fetchImpl: async (url, options) =>
            String(url).includes("/blobs/") ? new Response(bad) : f.fetchImpl(url, options),
        }),
        /archive digest/,
      );
      assert.equal(readFileSync(join(f.destination, "previous"), "utf8"), "keep");
    }
  } finally {
    f.close();
  }
});

for (const [name, overrides, message] of [
  ["stale source", { source: "0".repeat(64) }, /need rebuilding/],
  ["wrong protocol", { protocol: 0 }, /protocol or engine/],
  ["wrong engine", { engine: "act/other" }, /protocol or engine/],
  ["missing target", { files: {} }, /invalid Actions runner/],
])
  test(`refuses ${name} before replacing installed files`, async () => {
    const f = fixture(overrides);
    mkdirSync(f.destination);
    writeFileSync(join(f.destination, "previous"), "keep");
    try {
      await assert.rejects(install(f), message);
      assert.equal(readFileSync(join(f.destination, "previous"), "utf8"), "keep");
    } finally {
      f.close();
    }
  });

test("verifies each binary even when the registry layer digest is valid", async () => {
  const f = fixture({
    files: Object.fromEntries(
      RUNNER_TARGETS.map(([os, arch]) => [
        `${os}/${arch}`,
        { name: `openship-actions-${os}-${arch}`, sha256: "0".repeat(64) },
      ]),
    ),
  });
  try {
    await assert.rejects(install(f), /invalid Actions runner/);
  } finally {
    f.close();
  }
});

test("requires an immutable image digest and a source fingerprint", () => {
  for (const image of [
    "ghcr.io/oblien/openship-actions-runner:latest",
    "http://example.com/runner",
    "ghcr.io/oblien/runner@sha256:bad",
  ])
    assert.throws(
      () => validateRunnerArtifact({ schemaVersion: 1, source: "a".repeat(64), image }),
      /Invalid pinned/,
    );
});

test("all product staging uses verified local assets without requiring Go, Docker or networking", () => {
  const f = fixture();
  const repo = join(f.root, "repo");
  mkdirSync(join(repo, "dist"), { recursive: true });
  try {
    // Copy only the loader and its complete artifact set. No build.mjs, Go,
    // Docker daemon or remote server is available in this product-build fixture.
    for (const name of ["assets.mjs", "distribution.mjs"])
      writeFileSync(join(repo, name), readFileSync(join(directory, name)));
    writeFileSync(join(repo, "artifact.json"), "null");
    const source = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { runnerFingerprint } from ${JSON.stringify(new URL(`file://${join(repo, "assets.mjs")}`).href)}; console.log(runnerFingerprint());`,
      ],
      { encoding: "utf8" },
    ).trim();
    for (const name of RUNNER_ASSET_NAMES)
      writeFileSync(join(repo, "dist", name), readFileSync(join(f.dist, name)));
    const manifest = JSON.parse(readFileSync(join(repo, "dist/manifest.json")));
    manifest.source = source;
    writeFileSync(join(repo, "dist/manifest.json"), JSON.stringify(manifest));
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { stageActionRunnerAssets } from ${JSON.stringify(new URL(`file://${join(repo, "assets.mjs")}`).href)}; stageActionRunnerAssets(${JSON.stringify(join(repo, "desktop/server/assets/actions-runner"))}); stageActionRunnerAssets(${JSON.stringify(join(repo, "api/dist/assets/actions-runner"))}); stageActionRunnerAssets(${JSON.stringify(join(repo, "cli/server/assets/actions-runner"))});`,
      ],
      { env: { ...process.env, PATH: "" }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const product of ["desktop/server", "api/dist", "cli/server"])
      assert.equal(
        JSON.parse(readFileSync(join(repo, product, "assets/actions-runner/manifest.json"))).source,
        source,
      );
  } finally {
    f.close();
  }
});

test("a failed pinned download never silently compiles another worker", () => {
  const root = mkdtempSync(join(tmpdir(), "openship-worker-download-failure-"));
  try {
    for (const name of ["assets.mjs", "distribution.mjs"])
      writeFileSync(join(root, name), readFileSync(join(directory, name)));
    writeFileSync(
      join(root, "offline.mjs"),
      'globalThis.fetch = async () => { throw new Error("registry offline fixture"); };',
    );
    writeFileSync(
      join(root, "build.mjs"),
      'import { writeFileSync } from "node:fs"; writeFileSync(new URL("./compiled", import.meta.url), "unexpected");',
    );
    const moduleUrl = new URL(`file://${join(root, "assets.mjs")}`).href;
    const source = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { runnerFingerprint } from ${JSON.stringify(moduleUrl)}; console.log(runnerFingerprint());`,
      ],
      { encoding: "utf8" },
    ).trim();
    writeFileSync(
      join(root, "artifact.json"),
      JSON.stringify({
        schemaVersion: 1,
        source,
        image: `ghcr.io/oblien/openship-actions-runner@sha256:${"a".repeat(64)}`,
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", join(root, "offline.mjs"), join(root, "assets.mjs")],
      {
        env: {
          ...process.env,
          OPENSHIP_ACTIONS_RUNNER_BUILD: "",
          NODE_OPTIONS: `--import=${join(root, "offline.mjs")}`,
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Could not fetch the pinned Actions worker release/);
    assert.throws(() => readFileSync(join(root, "compiled")), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the API image and native products pin the same compatible worker release", (context) => {
  const descriptor = JSON.parse(readFileSync(join(directory, "artifact.json")));
  if (!descriptor) return context.skip("bootstrap producer has not pinned its first artifact yet");
  validateRunnerArtifact(descriptor);
  if (process.env.OPENSHIP_ACTIONS_RUNNER_BUILD !== "1")
    assert.equal(
      descriptor.source,
      runnerFingerprint(),
      "publish and pin the changed worker source before shipping it",
    );
  const dockerfile = readFileSync(join(directory, "../../apps/api/Dockerfile"), "utf8");
  assert.equal(/^ARG ACTIONS_RUNNER_IMAGE=(.+)$/m.exec(dockerfile)?.[1], descriptor.image);
});

test("the shared loader can be imported by stdin-based build tooling", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: `import { runnerFingerprint } from ${JSON.stringify(new URL("./assets.mjs", import.meta.url).href)}; console.log(runnerFingerprint());`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^[a-f0-9]{64}$/);
});

test("worker identity covers compiled and embedded sources while distribution-only edits reuse it", () => {
  const root = mkdtempSync(join(tmpdir(), "openship-worker-identity-"));
  try {
    writeFileSync(join(root, "worker.go"), "worker source");
    writeFileSync(join(root, "github-gate.cjs"), "embedded admission adapter");
    writeFileSync(join(root, "go.mod"), "pinned dependency graph");
    const original = runnerFingerprint(root);
    for (const name of [
      "distribution.mjs",
      "distribution.test.mjs",
      "worker_test.go",
      "github-gate.test.cjs",
      "README.md",
    ])
      writeFileSync(join(root, name), "changed packaging or tests");
    assert.equal(runnerFingerprint(root), original);
    writeFileSync(join(root, "github-gate.cjs"), "changed embedded admission adapter");
    assert.notEqual(runnerFingerprint(root), original);
    const embedded = runnerFingerprint(root);
    writeFileSync(join(root, "go.mod"), "new pinned dependency graph");
    assert.notEqual(runnerFingerprint(root), embedded);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
