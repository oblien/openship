import { Command } from "commander";

export const deployCommand = new Command("deploy")
  .description("Deploy the current project")
  .option("--prod", "Deploy to production")
  .option("--preview", "Create a preview deployment")
  .action(async (opts) => {
    // TODO: Read openship.json, upload or push, trigger deployment via API
    const env = opts.prod ? "production" : "preview";
    console.log(`Deploying to ${env}...`);
  });
