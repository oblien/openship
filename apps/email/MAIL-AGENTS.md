# Mail scheduling and agents

OpenShip Mail uses the published `mindwire@0.1.61` daemon SDK. It has no dependency on a sibling Mindwire checkout. Users connect an OpenAI or Anthropic API key, or a Responses-compatible custom API, from Settings → AI & agents. Mindwire owns authentication, agent setup and conversations. Native agents run in a separate mailbox container or an explicitly assigned isolated runtime; they never execute inside the webmail API or the OpenShip Cloud control plane.

For sample inboxes and a real local IMAP/SMTP cycle, run `bun run dev:email:sample` from the repository root. See [the sample environment guide](dev/README.md).

## Mailbox flow

- **Send later** uses the existing composer and SMTP driver. Scheduled mail is persisted in SQLite, survives a server restart and browser sign-out, and appears in **Mail → Scheduled**. Users can change its time or cancel before processing starts.
- **Undo Send** now cancels a real delayed job. The delay follows the existing Undo Send preference. A message already handed to SMTP cannot be recalled.
- **Snooze** persists a wake-up time and uses the existing IMAP snooze/unsnooze operations. Re-snoozing or manually waking a message supersedes its old schedule.
- **Settings → AI & agents** offers a compact AI connection dialog and a separate MCP connection dialog. Opening Connect AI prepares the mailbox runtime and shows progress before accepting the key. The global assistant and the existing **Write with AI** composer share the same integration. Compose suggestions use separate temporary chats with no mailbox MCP tools.
- Agents can search/read mail, save drafts, or prepare send proposals, according to the selected scopes. Every agent send needs approval of its immutable recipients, body, attachments and schedule in **Scheduled**. Approval leaves at least 15 seconds to cancel. There is no MCP approval or direct-send tool.

The server uses the same mailbox identity and IMAP/SMTP operations for the browser and MCP. Mailbox identity includes the instance namespace, email address and backend hosts/ports. A dashboard administrator or Cloud API credential does not authenticate to the mail MCP endpoint.

## Connecting an external agent

Create a connection in **Settings → AI & agents**, select its permissions, and copy its token once. The UI creates a 30-day token; the API permits up to 90 days. Configure a Streamable HTTP MCP client with:

```json
{
  "mcpServers": {
    "openship_mail": {
      "url": "https://mail.example.com/mcp",
      "headers": { "Authorization": "Bearer <mailbox-token>" }
    }
  }
}
```

Some clients call the header field `httpHeaders`. This first implementation uses scoped bearer tokens, **not OAuth discovery/consent**. Clients must support configuring an Authorization header. Revoking a connection prevents new calls, withholds data from in-flight reads and cancels queued proposals. It cannot recall a message whose SMTP dispatch has already begun.

## Built-in AI connections

Users choose **Connect AI**, select OpenAI, Anthropic or Custom API, and enter their own API key. Custom APIs require an HTTPS base URL, a model ID, Responses API support and tool calling. The initial connection grants read and draft access only. Send proposals are a separate opt-in and always require approval. This flow uses API keys, not ChatGPT/Claude subscription sign-in. API usage is billed by the selected provider.

The SDK installs its supported native agent through `setup`, reports progress through `setupStatus`, and connects credentials through `auth` or `providers`. Webmail stores only connection display metadata. Keys remain in the mailbox's private Mindwire state, are never returned by mail APIs, and are removed through Mindwire on disconnect. If removal fails, mail access is revoked immediately and the connection remains visible for a cleanup retry. Native credential storage follows Mindwire's policy; it is not part of the mail SQLite backup.

### Deployment setup (once per mail installation)

Automatic provisioning is explicitly enabled by the operator. Use a dedicated Docker engine for mail assistants; do not supply a Cloud control-plane or general production engine socket. Configure the webmail server with:

```sh
MAIL_MINDWIRE_DOCKER_SOCKET=/path/to/dedicated/docker.sock
MAIL_PUBLIC_URL=https://mail.example.com
```

When the API and runtime containers share a private Docker network, also set:

```sh
MAIL_MINDWIRE_DOCKER_NETWORK=mail-assistants
MAIL_MINDWIRE_MCP_URL=http://webmail:4080/mcp
```

These are server settings, not values accepted from users. The API needs permission to manage that dedicated engine. The local sample environment wires this automatically to its selected local Docker engine. Ordinary webmail deployments do not gain Docker access automatically.

The published SDK provisions one container per instance-scoped mailbox identity. A shared image contains OS prerequisites only; keys and conversations stay in each container's writable layer. Containers have no host mounts or Docker socket, no additional capabilities, no new privileges, and limits of 512 MB, one CPU and 128 processes. At most 32 assistant containers are admitted per engine. Daemon ports are bound to host loopback; containerized webmail connects over its private network with a separate daemon token. Page reads do not provision runtimes. Setup begins only when a signed-in user opens Connect AI.

Keep runtime containers and their private state across webmail upgrades. An intentional runtime reset removes saved AI connections, so users must reconnect. Restrict worker-network egress to the mail API and approved AI providers; filesystem isolation does not replace network policy. Read-only native settings and mail-only instructions are additional controls, not a substitute for the container boundary.

### Existing isolated runtimes

Operators can still bind a mailbox to an existing dedicated Mindwire daemon using `MAIL_MINDWIRE_TARGETS`. Obtain its mailbox identifier from the authenticated `assistant.state` API and configure:

```sh
MAIL_MINDWIRE_TARGETS='{"<mailbox-identifier>":{"url":"https://alice-agent.example.com","token":"<daemon-access-token>","agent":"codex","directory":"/workspace/mail"}}'
```

Each endpoint must belong to exactly one mailbox, with no unrelated files, hooks, tools or credentials. HTTPS is required in production. Users still connect their provider from Settings; manual provider authentication is no longer required. The runtime must support application-managed bots (`botsVersion >= 9`).

Each assistant turn receives a short-lived token tied to that mailbox's consent. Turning the assistant off revokes access, cancels pending proposals and attempts to cancel the active turn. Consent expires after 90 days and can be renewed by enabling again. Mail read by the assistant is shared with the assigned runtime and its configured model provider. Only message references actually read through MCP become clickable citations.

## Persistence and delivery semantics

Queued payloads, credential snapshots and assistant history are encrypted with the existing `SESSION_ENCRYPTION_KEY`, with authenticated context binding them to their mailbox and record. Keep the key with a database backup. The database and key are server secrets: access to both grants access to retained mailbox credentials. Scheduling and MCP consent authorize work after the browser signs out; use cancellation/revocation to stop that access.

Only token hashes are stored. Job credentials are removed on completion/cancellation; grant credentials are removed on revocation/expiry. Completed and cancelled jobs are removed after 30 days. Each mailbox is limited to 100 active jobs, 50 MB of outbox storage and 20 active grants. Failed or uncertain jobs remain visible until removed. Local assistant history retains the latest 50 messages; the assigned Mindwire host and AI provider have their own transcript retention policies.

The worker atomically claims a job before sending. It never automatically resends after an ambiguous SMTP error or interrupted send. Such jobs display **Check delivery**: inspect Sent or confirm with the recipient before manually sending again. Exactly-once SMTP delivery cannot be guaranteed across a lost acknowledgement.

## Validation

Run from each nested package, using the repository's pinned Bun version:

```sh
cd apps/email/server
bun test
bun run build
cd ../client
bun test
bunx tsc --noEmit
bun run build
```

Server tests use temporary databases. Coverage includes cross-mailbox denial, scopes, expiry/revocation, immutable approvals, worker claims and cancellation, restart persistence, snooze rescheduling, MIME attachments, exact draft replacement and the installed Mindwire SDK over HTTP/SSE fixtures. Tests do not send mail to external recipients or invoke a live AI provider.
