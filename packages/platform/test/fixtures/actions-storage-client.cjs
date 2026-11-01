// Run in a child process so test-only TLS trust and toolkit environment never
// affect the API process. These are the clients used by the official actions.
const fs = require("node:fs/promises");
const path = require("node:path");
const { DefaultArtifactClient } = require("@actions/artifact");
const cache = require("@actions/cache");

async function main() {
  const root = process.env.GITHUB_WORKSPACE;
  const file = path.join(root, "payload.txt");
  await fs.writeFile(file, "artifact and cache survive another job\n");
  const client = new DefaultArtifactClient();
  if (process.argv[2] === "artifact") {
    const upload = await client.uploadArtifact("build-output", [file], root, { retentionDays: 1 });
    process.env.ACTIONS_RUNTIME_TOKEN = process.env.NEXT_JOB_TOKEN;
    const list = await client.listArtifacts();
    if (list.artifacts.length !== 1) throw new Error("Artifact was not listed for the dependent job");
    const target = path.join(root, "download");
    await client.downloadArtifact(upload.id, { path: target });
    if ((await fs.readFile(path.join(target, "payload.txt"), "utf8")) !== await fs.readFile(file, "utf8")) throw new Error("Downloaded artifact changed");
    console.log(`RESULT:${JSON.stringify({ id: upload.id, size: upload.size })}`);
  } else {
    const key = "linux-node-project-lockfile";
    const id = await cache.saveCache([file], key);
    if (typeof id !== "number" || id < 0) throw new Error("Cache was not saved");
    await fs.unlink(file);
    process.env.ACTIONS_RUNTIME_TOKEN = process.env.NEXT_JOB_TOKEN;
    const restored = await cache.restoreCache([file], "linux-node-project-new", ["linux-node-project-"]);
    if (restored !== key || !String(await fs.readFile(file)).includes("survive another job")) throw new Error("Cache was not restored");
    console.log(`RESULT:${JSON.stringify({ id, restored })}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
