# Openship plugin for Codex and Claude Code

Packages Openship's existing MCP server with a workflow skill and a connection-check onboarding
skill. Both clients share the skills and connect to **Openship Cloud** at
`https://api.openship.io/api/mcp`, using OAuth and dynamic client registration. Each user authorizes
their own account and resource scope. No API key, extra server, or monorepo build is needed.

## Install from GitHub

Users can run these commands from any directory. The client downloads and caches the plugin;
there is no manual clone, dependency install, or Openship build. These examples use the default
branch and become available once the plugin is merged.

### Codex

```bash
codex plugin marketplace add oblien/openship
codex plugin add openship@openship
```

If your Codex client provides plugin installation through its UI, register the marketplace with
the first command, then install **Openship** from that marketplace in the plugin directory.

### Claude Code

```bash
claude plugin marketplace add oblien/openship
claude plugin install openship@openship
```

The equivalent commands inside Claude Code are `/plugin marketplace add oblien/openship` and
`/plugin install openship@openship`.

### Preview a published branch

Before the plugin reaches the default branch, register the published feature branch instead:

```bash
codex plugin marketplace add oblien/openship --ref feat/codex-plugin
```

```bash
claude plugin marketplace add 'oblien/openship#feat/codex-plugin'
```

Then run the corresponding install command above.

### Connect your account

Restart the client and start a new conversation. Complete the Openship browser authorization
through the client's connection flow; in Claude Code, use `/mcp` to authenticate the plugin's
Openship server. Run the plugin's setup skill to verify the connection and list permitted
workspaces. Claude Code exposes it as `/openship:openship-setup`; Codex also provides the plugin's
setup action. Setup succeeds only after an authenticated tool call returns.

Then try “Deploy this repository with Openship” or “Investigate my failed Openship deployments.”
Openship checks the approved permissions on every call.

## Install from this checkout

For plugin development or a customized endpoint, register this checkout from the repository root.

Codex:

```bash
codex plugin marketplace add .
codex plugin add openship@openship
```

Claude Code:

```bash
claude plugin marketplace add .
claude plugin install openship@openship
```

The marketplace makes the plugin available; it does not automatically enable it for everyone
working in this repository. Installation and connection still happen in the user's client.

## Desktop and self-hosted instances

Before installing, replace `mcpServers.openship.url` in `mcp.json` (Codex) and `.mcp.json`
(Claude Code) with the exact endpoint copied from your instance's **Settings → MCP**. Keep each
file's existing transport and authentication settings. The endpoint may include a proxy path;
do not derive it from the dashboard URL.

Register this checkout as a **local** marketplace as above so the client uses your customized package.
After changing an already installed package, refresh the local marketplace and reinstall/refresh
the plugin in the client, then authorize the selected instance. Installed plugins are cached;
editing the source folder alone does not update the installed copy.

Connect from a machine that can reach the instance. Hosted agents cannot access a desktop or
LAN-only endpoint. The [MCP guide](https://openship.io/docs/mcp) also documents direct Codex MCP
registration for clients without plugin support.

## Package and distribution

`plugin.json` and `mcp.json` use Codex's portable Agent Plugins format.
`.claude-plugin/plugin.json` and `.mcp.json` provide Claude Code's native format. Both discover
the same `skills/` directory. Assets and the license are self-contained under this folder.

The repository catalogs are `../../.agents/plugins/marketplace.json` for Codex and
`../../.claude-plugin/marketplace.json` for Claude Code. Both point at this plugin folder with a
source path relative to the repository root. Keep the identity/version in both manifests and
the endpoint in both MCP configs aligned when releasing or customizing the plugin.

These are repository-distributed plugins, not public directory listings. Public directory
submission and browser OAuth testing in each target client remain separate steps. See the
[Codex packaging guide](https://developers.openai.com/plugins/build/plugins) and
[Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference).
