import { Command } from "commander";
import tab from "@bomb.sh/tab/commander";

export function attachCompletion(program: Command) {
  tab(program, { completionCommandName: "completion" });
}
