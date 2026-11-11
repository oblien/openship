---
name: openship-setup
description: Check an Openship plugin connection and discover its permitted workspaces after installation, or troubleshoot missing authentication and the selected instance.
---

Check the connected Openship server with `get_permissions_workspaces` and read `openship-overview`
through `get_mcp_guide` using `query.name`. Report the permitted workspace names and any credential
binding. Setup is complete only when a tool call succeeds. Do not create or deploy anything as part
of this connection check.

If authentication is required, direct the user to the client's connection/login flow. They approve
the workspace and resource scope in Openship's browser consent screen. Never ask for a token or
password in conversation, or read the client's stored credentials.

The packaged endpoint defaults to Openship Cloud. For a desktop or self-hosted instance, use the
exact endpoint shown in that instance's **Settings → MCP**, including any proxy path. Follow the
self-hosted instructions in this plugin's [README](../../README.md) before installing or refreshing
the local plugin. Do not silently connect Cloud when the user requested another instance.

In Claude Code, `/mcp` opens the server's authentication flow. After connecting, invoke
`/openship:openship-setup` again to check access. Codex exposes this skill through the plugin's
setup action.

The endpoint must be reachable from the environment running the agent. A hosted agent cannot
reach the user's localhost. If the tools are unavailable, explain the missing connection and the
next setup step; do not claim that the workspace is empty.
