import { prepareNodeOutput } from "./node-output";

export interface NextStandalonePlan { bundleDir: string; startCommand: string }

/** Next's manifest identifies the app inside a monorepo's complete traced bundle. */
export async function prepareNextStandalone(projectDir: string, rootDirectory?: string): Promise<NextStandalonePlan | null> {
  const plan = await prepareNodeOutput({ kind: "nextjs", projectDir, rootDirectory, directory: ".next", entry: "server.js" });
  return plan?.startCommand === "node 'server.js'" ? { ...plan, startCommand: "node server.js" } : plan;
}
