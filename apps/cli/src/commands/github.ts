import { Command, Option } from "commander";
import {
  GitHubCollectionSchemas,
  GitHubResourceSchemas,
  OwnerRepoParams,
  parseInput,
} from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { positiveInteger, readJsonInput, readSecret } from "../lib/command-input";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";

function repository(value: string) {
  const [owner, repo, extra] = value.split("/");
  if (extra !== undefined) throw new Error("Use a GitHub repository in owner/repo form.");
  return parseInput(OwnerRepoParams, { owner, repo });
}

export const githubCommand = new Command("github").description(
  "Connect GitHub, browse repositories and manage deployment sources",
);
for (const [name, method, description] of [
  ["status", "getStatus", "Show available connection methods and current GitHub access"],
  ["home", "getHome", "Show connected accounts and recent repositories"],
  [
    "local-status",
    "getLocalStatus",
    "Inspect GitHub credentials on the selected Openship instance",
  ],
] as const) {
  githubCommand
    .command(name)
    .description(description)
    .action(() => printResult(() => getShipClient().github[method]()));
}
githubCommand
  .command("connect")
  .description(
    "Begin a connection; follow the returned browser, device or installation instructions",
  )
  .addOption(new Option("--source <method>", "Connection method").choices(["oauth", "cli"]))
  .option("--state <state>", "Resume this connection attempt")
  .action((opts) =>
    printResult(() => getShipClient().github.connect({ source: opts.source, state: opts.state })),
  );
githubCommand
  .command("poll")
  .description("Check whether a connection attempt completed")
  .option("--state <state>", "Attempt state from github connect")
  .action((opts) => printResult(() => getShipClient().github.pollConnect({ state: opts.state })));
githubCommand
  .command("claim")
  .argument("<installation>", "Installation ID offered by github connect")
  .requiredOption("--state <state>", "Exact connection attempt state")
  .description("Select an installation offered to the authenticated user")
  .action((installationId: string, opts) =>
    printResult(() =>
      getShipClient().github.claimInstallation({ installationId, state: opts.state }),
    ),
  );
githubCommand
  .command("token")
  .argument("<file>", "Token file, or - for stdin")
  .description("Set the instance's GitHub personal token (self-hosted administrators)")
  .action((file: string) =>
    printResult(() => getShipClient().github.setInstanceToken({ token: readSecret(file) })),
  );
githubCommand
  .command("disconnect")
  .description("Disconnect a GitHub credential source")
  .addOption(
    new Option("--source <method>", "Credential to disconnect")
      .choices(["oauth", "cli", "all"])
      .default("all"),
  )
  .option("-y, --yes", "Confirm disconnection")
  .action((opts) =>
    printResult(async () => {
      await confirmOrExit(opts.yes, `Disconnect GitHub (${opts.source})?`);
      return getShipClient().github.disconnect({ source: opts.source });
    }),
  );

const repo = new Command("repo").description(
  "Browse and manage repositories available to this connection",
);
repo
  .command("list")
  .description("List repositories with explicit pagination and filters")
  .option("--owner <name>", "Repository owner filter")
  .option("--org <name>", "List this GitHub organization's repositories")
  .option("--page <number>", "Page number", positiveInteger)
  .option("--per-page <number>", "Page size", positiveInteger)
  .option("--search <text>", "Repository search")
  .addOption(
    new Option("--visibility <type>", "Visibility filter").choices(["all", "public", "private"]),
  )
  .addOption(new Option("--sort <field>", "Sort order").choices(["updated", "name", "stars"]))
  .action((opts) =>
    printResult(() => {
      const input = {
        owner: opts.owner,
        page: opts.page,
        perPage: opts.perPage,
        search: opts.search,
        visibility: opts.visibility,
        sort: opts.sort,
      };
      return opts.org
        ? getShipClient().github.listOrgRepos({ ...input, org: opts.org })
        : getShipClient().github.listRepos(input);
    }),
  );
repo
  .command("get")
  .argument("<repository>", "owner/repo")
  .option("--branches", "Include the first branch page")
  .description("Inspect a repository")
  .action((value: string, opts) =>
    printResult(() =>
      getShipClient().github.getRepo({ ...repository(value), branches: opts.branches }),
    ),
  );
repo
  .command("create")
  .argument("<name>", "Repository name")
  .option("--owner <name>", "GitHub owner or organization")
  .option("--description <text>", "Repository description")
  .option("--public", "Create a public repository (default: private)")
  .description("Create a GitHub repository")
  .action((name: string, opts) =>
    printResult(() =>
      getShipClient().github.createRepo({
        name,
        owner: opts.owner,
        description: opts.description,
        private: !opts.public,
      }),
    ),
  );
repo
  .command("remove")
  .argument("<repository>", "owner/repo")
  .option("-y, --yes", "Confirm deletion on GitHub")
  .description("Permanently delete a GitHub repository")
  .action((value: string, opts) =>
    printResult(async () => {
      const input = repository(value);
      await confirmOrExit(opts.yes, `Permanently delete GitHub repository ${value}?`);
      return getShipClient().github.deleteRepo(input);
    }),
  );
repo
  .command("branches")
  .argument("<repository>", "owner/repo")
  .option("--page <number>", "Page number", positiveInteger)
  .description("List branches and whether another page is available")
  .action((value: string, opts) =>
    printResult(() =>
      getShipClient().github.listBranches({ ...repository(value), page: opts.page }),
    ),
  );
repo
  .command("clone-token")
  .argument("<repository>", "owner/repo")
  .description("Print a short-lived clone credential; output contains a secret")
  .action((value: string) =>
    printResult(() => getShipClient().github.getCloneToken(repository(value))),
  );
repo
  .command("detect")
  .argument("<repository>", "owner/repo")
  .option("--branch <name>", "Branch to inspect")
  .option("--compose-path <path>", "Compose file to inspect")
  .description("Detect stack, build configuration and Compose services")
  .action((value: string, opts) =>
    printResult(() =>
      getShipClient().github.detectStack({
        ...repository(value),
        branch: opts.branch,
        composePath: opts.composePath,
      }),
    ),
  );
repo
  .command("files")
  .argument("<repository>", "owner/repo")
  .option("--branch <name>", "Branch")
  .option("--path <path>", "Directory or file path")
  .description("List files at a repository path")
  .action((value: string, opts) =>
    printResult(() =>
      getShipClient().github.listFiles({
        ...repository(value),
        branch: opts.branch,
        path: opts.path,
      }),
    ),
  );
repo
  .command("tree")
  .argument("<repository>", "owner/repo")
  .option("--branch <name>", "Branch")
  .description("List the repository tree")
  .action((value: string, opts) =>
    printResult(() =>
      getShipClient().github.listTree({ ...repository(value), branch: opts.branch }),
    ),
  );
repo
  .command("file")
  .argument("<repository>", "owner/repo")
  .argument("<path>", "File path")
  .option("--branch <name>", "Branch")
  .description("Read a repository file and its revision")
  .action((value: string, file: string, opts) =>
    printResult(() =>
      getShipClient().github.getFile({ ...repository(value), file, branch: opts.branch }),
    ),
  );

const webhook = new Command("webhook").description(
  "Manage Openship deployment webhooks on a GitHub repository",
);
for (const [name, method] of [
  ["list", "listWebhooks"],
  ["register", "registerWebhook"],
] as const) {
  webhook
    .command(name)
    .argument("<repository>", "owner/repo")
    .description(`${name} repository webhooks`)
    .action((value: string) =>
      printResult(() => getShipClient().github[method](repository(value))),
    );
}
webhook
  .command("remove")
  .argument("<repository>", "owner/repo")
  .argument("<hook>", "Webhook ID", positiveInteger)
  .option("-y, --yes", "Confirm webhook removal")
  .description("Delete a repository webhook")
  .action((value: string, hookId: number, opts) =>
    printResult(async () => {
      const input = { ...repository(value), hookId };
      await confirmOrExit(opts.yes, `Remove webhook ${hookId} from ${value}?`);
      return getShipClient().github.deleteWebhook(input);
    }),
  );
repo.addCommand(webhook);
githubCommand.addCommand(repo);

const sources = new Command("source").description(
  "Configure self-hosted GitHub Apps and their installations",
);
sources
  .command("list")
  .description("List configured GitHub Apps and callback readiness")
  .action(() => printResult(() => getShipClient().github.listSources()));
sources
  .command("manifest")
  .argument("<name>", "App name")
  .description("Generate a GitHub App registration manifest")
  .action((name: string) => printResult(() => getShipClient().github.beginManifest({ name })));
sources
  .command("convert")
  .argument("<file>", "JSON state and code from GitHub registration, or - for stdin")
  .description("Complete manifest registration with its matching state and code")
  .action((file: string) =>
    printResult(() =>
      getShipClient().github.convertManifest(
        parseInput(GitHubCollectionSchemas.convertManifest.input, readJsonInput(file)),
      ),
    ),
  );
sources
  .command("create")
  .argument("<file>", "JSON GitHub App credentials, or - for stdin")
  .description("Register an existing GitHub App")
  .action((file: string) =>
    printResult(() =>
      getShipClient().github.createManualSource(
        parseInput(GitHubCollectionSchemas.createManualSource.input, readJsonInput(file)),
      ),
    ),
  );
sources
  .command("update")
  .argument("<id>", "Source ID")
  .argument("<file>", "JSON changes, or - for stdin")
  .description("Update a configured GitHub App")
  .action((id: string, file: string) =>
    printResult(() =>
      getShipClient().github.updateSource(
        id,
        parseInput(GitHubResourceSchemas.updateSource.input, readJsonInput(file)),
      ),
    ),
  );
for (const [name, method, description] of [
  ["verify", "verifySource", "Verify this App's configuration"],
  ["default", "setDefaultSource", "Use this App by default"],
  ["install", "createInstallUrl", "Create a URL to install this App on a GitHub account"],
] as const) {
  sources
    .command(name)
    .argument("<id>", "Source ID")
    .description(description)
    .action((id: string) => printResult(() => getShipClient().github[method](id)));
}
sources
  .command("remove")
  .argument("<id>", "Source ID")
  .option("-y, --yes", "Confirm source removal")
  .description("Disconnect a configured GitHub App")
  .action((id: string, opts) =>
    printResult(async () => {
      await confirmOrExit(opts.yes, `Remove GitHub source ${id}?`);
      return getShipClient().github.deleteSource(id);
    }),
  );
githubCommand.addCommand(sources);
