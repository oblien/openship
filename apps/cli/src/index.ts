#!/usr/bin/env node

import { Command } from "commander";
import { deployCommand } from "./commands/deploy";
import { loginCommand } from "./commands/login";
import { initCommand } from "./commands/init";
import { logsCommand } from "./commands/logs";

const program = new Command();

program
  .name("openship")
  .description("Openship CLI — deploy from your terminal")
  .version("0.1.0");

program.addCommand(initCommand);
program.addCommand(loginCommand);
program.addCommand(deployCommand);
program.addCommand(logsCommand);

program.parse();
