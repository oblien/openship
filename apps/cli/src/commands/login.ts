import { Command } from "commander";

export const loginCommand = new Command("login")
  .description("Authenticate with your Openship account")
  .action(async () => {
    // TODO: Open browser for OAuth or prompt for API token
    console.log("Logging in...");
  });
