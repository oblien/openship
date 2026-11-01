import { Command } from "commander";
import {
  AddDnsCredentialBody,
  IngressDiscoverBody,
  IngressConnectBody,
  IngressUpdateBody,
  IngressDomainBody,
  parseInput,
} from "@repo/contracts";
import { getShipClient } from "../lib/ship-client";
import { readJsonInput } from "../lib/command-input";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";

export const dnsCommand = new Command("dns").description("Manage DNS providers and zone access");
dnsCommand
  .command("providers")
  .description("List DNS providers, scopes and token setup links")
  .action(() => printResult(() => getShipClient().dns.listProviders()));
dnsCommand
  .command("verify-zone")
  .argument("<hostname>", "Hostname to resolve against your DNS credentials")
  .description("Check DNS zone access")
  .action((hostname: string) =>
    printResult(async () => {
      const result = await getShipClient().dns.verifyZone({ hostname });
      if (!result.matched) process.exitCode = 1;
      return result;
    }),
  );
const credentials = new Command("credentials").description("Manage DNS automation credentials");
credentials
  .command("list")
  .description("List masked DNS credentials")
  .action(() => printResult(() => getShipClient().dns.listCredentials()));
credentials
  .command("get")
  .argument("<id>", "Credential ID")
  .description("Show a masked DNS credential")
  .action((id: string) => printResult(() => getShipClient().dns.getCredential(id)));
credentials
  .command("add")
  .argument("<file>", "JSON object containing provider, name and apiToken")
  .description("Store DNS credentials for automatic records and certificates")
  .action((file: string) =>
    printResult(() =>
      getShipClient().dns.addCredential(parseInput(AddDnsCredentialBody, readJsonInput(file))),
    ),
  );
credentials
  .command("remove")
  .alias("rm")
  .argument("<id>", "Credential ID")
  .description("Remove DNS automation credentials")
  .option("-y, --yes", "Skip confirmation")
  .action((id: string, opts) =>
    printResult(async () => {
      await confirmOrExit(opts.yes, `Remove DNS credential ${id}?`);
      return getShipClient().dns.removeCredential(id);
    }),
  );
dnsCommand.addCommand(credentials);

const ingress = new Command("ingress").description(
  "Manage Cloudflare public ingress on connected self-hosted servers",
);
ingress
  .command("list")
  .option("--server <id>", "Filter by deployment server")
  .description("List saved tunnel bindings and setup status")
  .action((opts) =>
    printResult(() => getShipClient().dns.listIngressConnections({ serverId: opts.server })),
  );
ingress
  .command("discover")
  .argument("<file>", "JSON containing credentialId and optional accountId/includePolicies")
  .description("Discover Cloudflare accounts, remotely managed tunnels and reusable policies")
  .action((file: string) =>
    printResult(() =>
      getShipClient().dns.discoverIngress(parseInput(IngressDiscoverBody, readJsonInput(file))),
    ),
  );
ingress
  .command("connect")
  .argument("<file>", "JSON containing server, credential, account and tunnel settings")
  .description("Create or attach a named tunnel and optionally install its server connector")
  .action((file: string) =>
    printResult(() =>
      getShipClient().dns.connectIngress(parseInput(IngressConnectBody, readJsonInput(file))),
    ),
  );
ingress
  .command("defaults")
  .argument("<file>", "JSON containing id, defaultForDomains and defaultAccessPolicyId")
  .description("Change defaults for new custom domains without changing existing policies")
  .action((file: string) =>
    printResult(() =>
      getShipClient().dns.updateIngress(parseInput(IngressUpdateBody, readJsonInput(file))),
    ),
  );
ingress
  .command("retry")
  .argument("<id>", "Connection ID")
  .description("Retry durable tunnel setup or cleanup")
  .action((id: string) => printResult(() => getShipClient().dns.retryIngress(id)));
ingress
  .command("disconnect")
  .argument("<id>", "Connection ID")
  .option("-y, --yes", "Skip confirmation")
  .description("Unpublish owned hostnames and remove this binding's managed connector")
  .action((id: string, opts) =>
    printResult(async () => {
      await confirmOrExit(opts.yes, `Disconnect tunnel ${id} and unpublish its managed hostnames?`);
      return getShipClient().dns.removeIngress(id);
    }),
  );
const hostname = new Command("domain").description(
  "Manage a custom hostname's tunnel and Access policy",
);
hostname
  .command("get")
  .argument("<id>", "Domain ID")
  .description("Show persisted tunnel, DNS and Access status")
  .action((id: string) =>
    printResult(() => getShipClient().dns.getDomainIngress({ domainId: id })),
  );
hostname
  .command("set")
  .argument("<file>", "JSON containing domainId, connectionId and optional accessPolicyId")
  .option("-y, --yes", "Skip disconnection confirmation")
  .description("Connect a hostname, change its policy, or disconnect with connectionId=null")
  .action((file: string, opts) =>
    printResult(async () => {
      const input = parseInput(IngressDomainBody, readJsonInput(file));
      if (input.connectionId === null)
        await confirmOrExit(opts.yes, `Unpublish managed hostname for domain ${input.domainId}?`);
      return getShipClient().dns.setDomainIngress(input);
    }),
  );
ingress.addCommand(hostname);
dnsCommand.addCommand(ingress);
