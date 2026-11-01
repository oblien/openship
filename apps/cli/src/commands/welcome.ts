import { intro, isCancel, log, outro, select } from "@clack/prompts";
import { getActiveContext, getContext } from "../lib/config";
import { exitCommand } from "../lib/command-exit";
import { promptSelfHostedUrl, runLogin } from "./login";

/** First run is a choice of destination; installing a server is explicit. */
export async function runWelcome(install: () => Promise<void>, help: () => void): Promise<void> {
  intro("Openship");
  const active = getContext();
  if (active.apiUrl) {
    log.info(`Current connection: ${getActiveContext()} (${active.apiUrl})`);
    log.message("Run openship project list to manage it, or choose another connection below.");
  }
  const action = await select({
    message: "What would you like to do?",
    initialValue: active.apiUrl ? "help" : process.platform === "linux" ? "install" : "cloud",
    options: [
      {
        value: "cloud",
        label: "Connect to Openship Cloud",
        hint: "manage Cloud from this machine",
      },
      {
        value: "remote",
        label: "Connect to self-hosted Openship",
        hint: "use an existing installation",
      },
      {
        value: "install",
        label: "Install Openship on this machine",
        hint: "interactive server setup",
      },
      { value: "help", label: "Show commands" },
    ],
  });
  if (isCancel(action)) exitCommand(0);
  if (action === "install") return install();
  if (action === "help") {
    help();
    return;
  }
  if (action === "cloud") await runLogin({ cloud: true });
  else {
    const apiUrl = await promptSelfHostedUrl();
    await runLogin({ apiUrl, context: new URL(apiUrl).host });
  }
  outro("Connected. Start with openship project list or openship --help.");
}
