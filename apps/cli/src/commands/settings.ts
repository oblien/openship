import { defaultAppearance, mergeAppearanceImport } from "@repo/core";
import { Command, Option } from "commander";
import { UserSettingsSchemas, parseInput } from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { readJsonInput, readSecret } from "../lib/command-input";
import { printResult } from "../lib/cmd-helpers";

export const settingsCommand = new Command("settings").description(
  "Manage user preferences on the selected Openship instance",
);
settingsCommand
  .command("get")
  .description("Read deployment, cloning and transfer preferences")
  .action(() => printResult(() => getShipClient().settings.get()));
settingsCommand
  .command("update")
  .argument("<file>", "JSON settings patch, or - for stdin")
  .description("Update supported user preferences")
  .action((file: string) =>
    printResult(() =>
      getShipClient().settings.update(
        parseInput(UserSettingsSchemas.update.input, readJsonInput(file)),
      ),
    ),
  );
for (const [name, method, field, description] of [
  ["build-mode", "setBuildMode", "buildMode", "auto | server | local"],
  ["route-strategy", "setRouteStrategy", "routeStrategy", "auto | loopback-port | container-ip"],
  ["clone-strategy", "setCloneStrategy", "preference", "prompt | local | remote-with-token"],
] as const) {
  settingsCommand
    .command(name)
    .argument("<value>", description)
    .description(`Set the default ${name}`)
    .action((value: string) =>
      printResult(() => {
        const settings = getShipClient().settings;
        if (method === "setBuildMode")
          return settings.setBuildMode(
            parseInput(UserSettingsSchemas.setBuildMode.input, { [field]: value }),
          );
        if (method === "setRouteStrategy")
          return settings.setRouteStrategy(
            parseInput(UserSettingsSchemas.setRouteStrategy.input, { [field]: value }),
          );
        return settings.setCloneStrategy(
          parseInput(UserSettingsSchemas.setCloneStrategy.input, { [field]: value }),
        );
      }),
    );
}
settingsCommand
  .command("deploy-defaults")
  .argument("<file>", "JSON defaultDeployTarget and defaultServerId; null clears, - reads stdin")
  .description("Set deployment destination defaults")
  .action((file: string) =>
    printResult(() =>
      getShipClient().settings.setDeployDefaults(
        parseInput(UserSettingsSchemas.setDeployDefaults.input, readJsonInput(file)),
      ),
    ),
  );
settingsCommand
  .command("clone-token")
  .argument("<file>", "Token file, or - for stdin")
  .option("--default", "Use this token by default for cloning")
  .description("Save a cloning credential; responses do not disclose the token")
  .action((file: string, opts) =>
    printResult(() =>
      getShipClient().settings.setCloneCredentials({
        token: readSecret(file),
        asDefault: opts.default,
      }),
    ),
  );
settingsCommand
  .command("clear-clone-token")
  .description("Remove the saved cloning credential")
  .action(() => printResult(() => getShipClient().settings.setCloneCredentials({ token: null })));
settingsCommand
  .command("transfer")
  .description("Set volume transfer preferences")
  .addOption(
    new Option("--mode <mode>", "Transfer method").choices(["auto", "stream", "direct", "rsync"]),
  )
  .addOption(
    new Option("--compression <format>", "Compression").choices(["auto", "zstd", "gzip", "none"]),
  )
  .action((opts) =>
    printResult(() => {
      if (!opts.mode && !opts.compression) throw new Error("Supply --mode or --compression.");
      return getShipClient().settings.setTransferPreferences({
        transferMode: opts.mode,
        transferCompression: opts.compression,
      });
    }),
  );
settingsCommand
  .command("git-forwarding")
  .argument("<state>", "on | off")
  .description("Control forwarding of git identity to build servers")
  .action((state: string) =>
    printResult(() => {
      if (state !== "on" && state !== "off") throw new Error("Use on or off.");
      return getShipClient().settings.setGitForwarding({ enabled: state === "on" });
    }),
  );

const appearance = settingsCommand
  .command("appearance")
  .description("Manage personal theme JSON on the selected instance");
appearance
  .command("get")
  .description("Export saved appearance JSON")
  .action(() =>
    printResult(async () => (await getShipClient().settings.getAppearance()).appearance),
  );
appearance
  .command("set")
  .argument("<file>", "Appearance JSON file, or - for stdin")
  .description("Import and save a personal theme library")
  .action((file: string) =>
    printResult(async () => {
      const settings = getShipClient().settings;
      const value = readJsonInput(file);
      const appearance =
        value === null
          ? null
          : mergeAppearanceImport(
              value,
              (await settings.getAppearance()).appearance ?? defaultAppearance(),
            );
      return settings.setAppearance(
        parseInput(UserSettingsSchemas.setAppearance.input, { appearance }),
      );
    }),
  );
appearance
  .command("reset")
  .description("Clear saved personal appearance")
  .action(() => printResult(() => getShipClient().settings.setAppearance({ appearance: null })));
