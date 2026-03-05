import { Command } from "commander";

export const initCommand = new Command("init")
  .description("Initialize an Openship project in the current directory")
  .action(async () => {
    // TODO: Create openship.json config, detect framework, link to account
    console.log("Initializing Openship project...");
  });
