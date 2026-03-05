import { Command } from "commander";

export const logsCommand = new Command("logs")
  .description("Stream deployment logs")
  .argument("[deploymentId]", "Deployment ID (defaults to latest)")
  .action(async (deploymentId?: string) => {
    // TODO: Connect to API and stream logs
    console.log(`Streaming logs for ${deploymentId || "latest deployment"}...`);
  });
