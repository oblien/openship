# Sample mail development

From the repository root:

```sh
bun run dev:email:sample
```

Open **http://127.0.0.1:3040** and sign in with either account:

| Email                | Password      |
| -------------------- | ------------- |
| `alex@openship.test` | `sample-mail` |
| `sam@openship.test`  | `sample-mail` |

Requires Docker Desktop or Colima, OpenSSL, and the installed mail client dependencies (`bun run --cwd apps/email install:all` if needed). The first run downloads two pinned images and installs the API dependencies in a Docker volume. The runner uses a local Docker engine only; it does not change your default Docker context. If several local engines are running, select one with `DOCKER_CONTEXT=name`.

The client runs locally with hot reload. The API runs the current source in a container with hot reload. Vite proxies the existing auth, API, IDLE and MCP endpoints so the browser follows the normal same-origin flow. The API is available directly on `127.0.0.1:3041`.

Each inbox has sample messages, read/unread and starred items, attachments, and a saved draft. Alex also has an agent proposal to review in **Scheduled**. Send from Alex to Sam and use the account switcher (or a second browser profile) to see the delivery. Try a reply, Send later, Undo Send, snooze, and creating/revoking an MCP connection.

This uses [GreenMail](https://greenmail-mail-test.github.io/greenmail/), a real IMAP/SMTP test server that does not forward mail to the Internet. Its Docker network is internal and publishes no mail ports. The normal TLS validation stays enabled; only the sample API trusts the generated test certificate. Mailbox data, API state, and credentials are separate from your normal dev instance.

To check the cycle automatically while the environment is running:

```sh
bun run dev:email:sample check
```

This verifies real login, inbox reads, drafts, cancellation, scheduling, SMTP delivery, attachments, Sent copies, mailbox isolation, and MCP revocation. It sends only between the two sample accounts.

Ctrl+C stops the frontend. The sample backend stays running so your mail remains available between frontend restarts. API state survives backend restarts, but GreenMail stores messages in memory; restarting it recreates the sample inboxes. Source hot reload does not reset your current mail. After stopping the frontend, start a completely fresh environment (including pending jobs and tokens) with:

```sh
bun run dev:email:sample reset
```

To stop the sample environment, preserving API and assistant state:

```sh
bun run dev:email:sample down
```

Generated local files live in the ignored `apps/email/.dev-mail/` directory. In Settings → AI & agents, choose **Connect AI** and enter your own API key. The sample API uses the selected local Docker socket to prepare a separate Mindwire container for each mailbox. The first connection builds a small layer of runtime prerequisites and installs the published agent; the dialog shows progress. Assistant containers receive no host mounts, engine socket or other mailbox credentials. No AI account is connected by default and normal sample-mail checks never call a paid model. See [MAIL-AGENTS.md](../MAIL-AGENTS.md) for production deployment requirements.
