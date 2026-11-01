import { resolve } from "node:path";
import { OpenshipClient } from "openship/client";

const ship = new OpenshipClient({
  baseUrl: "https://ship.example.com",
  token: process.env.OPENSHIP_TOKEN!,
  organizationId: process.env.OPENSHIP_ORGANIZATION_ID!,
});

const run = await ship.deploy({
  name: "commerce-api",
  source: { type: "directory", path: resolve("./app") },
  onStep: console.log,
});

const result = await ship.deployment(run.deployment_id)
  .wait({ timeoutMs: 120_000 });

if (!result.success) throw new Error(result.status);
console.log("Ready:", run.project_id);
