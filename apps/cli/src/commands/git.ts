import { Command } from "commander";
import { GitCollectionSchemas as schemas } from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { jsonCommand } from "../lib/json-command";

/** Same validated provider operations as HTTP/native/SDK, with no transport here. */
export const gitCommand = new Command("git").description(
  "Browse and update sources through a connected Git provider",
);
jsonCommand(
  gitCommand
    .command("repos")
    .description("List accessible repositories, with provider, namespace and pagination"),
  schemas.listRepos.input,
  (input) => getShipClient().git.listRepos(input),
);
jsonCommand(
  gitCommand.command("repo").description("Inspect repository metadata"),
  schemas.getRepo.input,
  (input) => getShipClient().git.getRepo(input),
);
jsonCommand(
  gitCommand.command("branches").description("List repository branches"),
  schemas.listBranches.input,
  (input) => getShipClient().git.listBranches(input),
);
jsonCommand(
  gitCommand.command("files").description("List files within permitted source paths"),
  schemas.listFiles.input,
  (input) => getShipClient().git.listFiles(input),
);
jsonCommand(
  gitCommand.command("tree").description("Read the permitted repository tree"),
  schemas.listTree.input,
  (input) => getShipClient().git.listTree(input),
);
jsonCommand(
  gitCommand.command("file").description("Read one permitted source file"),
  schemas.getFile.input,
  (input) => getShipClient().git.getFile(input),
);
jsonCommand(
  gitCommand
    .command("detect")
    .description("Detect build configuration without exposing source contents"),
  schemas.detectStack.input,
  (input) => getShipClient().git.detectStack(input),
);
jsonCommand(
  gitCommand.command("publish").description("Publish a reviewed source patch"),
  schemas.publishChange.input,
  (input) => getShipClient().git.publishChange(input),
  "Publish these repository changes?",
);
