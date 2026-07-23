# Installing Openship

Openship runs in three shapes. Pick by **who uses it** and **whether it must be reachable when your machine is off**.

| Setup | Use when | How Openship runs |
|---|---|---|
| **Desktop app** | It's just you. Private. | Control plane runs **on your machine**, drives your server(s) over SSH. Nothing about Openship is exposed to the internet. |
| **Self-hosted on a server** | A team, always-on, remote access, CI / push-to-deploy | Control plane runs **on a Linux box** at a public URL, login required, invite-only. |
| **Openship Cloud** | Zero ops | Managed for you. |

---

## Solo / private → use the Desktop app (recommended)

For a single operator this is the best model: the control plane lives **locally** and manages your servers end-to-end over SSH. Openship itself has **no public app and no open port** — the only thing that ever goes public is an app *you* give a domain to. Smallest attack surface, nothing to secure.

**When this is the wrong choice:** the dashboard is only up while your machine is. No teammate access, no access from your phone, and push-to-deploy webhooks need a stable public endpoint your laptop isn't. If you need any of those, run Openship on a server (below).

**Install:**
- Download for your OS at [openship.io](https://openship.io), or run `openship install` (fetches the desktop build).
- On first launch, connect what you want to manage:
  - **This Machine** — manage the local box.
  - **Another Server** — add a remote server over SSH (host, user, key). Test Connection, then manage it.

---

## Team / always-on → install Openship on a server

Two ways to stand up the control plane on a Linux box. Point your domain's **DNS A record at the server first**.

### A) From the Desktop app

Add the server (SSH), then **install Openship onto it like any other app** — pick the server, install Openship, and it runs as an always-on app on that box with its own domain. Use this to promote from "local desktop control" to "always-on server" without touching a terminal.

### B) With the CLI (on the server)

Install the CLI, then just run **`openship`** — an interactive wizard walks you through it: it creates the **first admin**, attaches your domain, and installs Openship as a boot service. Run `openship` again later to manage the running instance.

```bash
curl -fsSL https://get.openship.io | sh      # install  (or: npm i -g openship)
openship                                     # interactive setup, then control panel
```

Prefer a one-shot, flag-driven setup for CI / headless boxes? Drive `openship up` directly instead of the wizard:

```bash
openship up --public-url https://ops.example.com
```

- `openship up` installs the same background service the wizard does (starts on boot, auto-restarts), driven entirely by flags.
- `--public-url <url>` makes the dashboard reachable at your domain. Login is required; everyone else joins by invite only.
- `--managed-edge` also installs OpenResty + a free Let's Encrypt cert on the box and routes your domain to the dashboard — no separate reverse proxy needed. Omit it if you run your own proxy in front.
- One-off attached run instead of a service: `openship up --foreground`.

Once it's up, **Openship registers itself as an app** (dashboard → Apps → *Openship*): manage its domain, tail its logs, and see it *Live* like any other app.

---

## Docker

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env
# Set INTERNAL_TOKEN + BETTER_AUTH_SECRET to long random values before starting
docker compose up -d --build
```

Open the dashboard at `http://localhost:3001` and create the **first admin** account
there. The dashboard proxies signup to the API with the compose `INTERNAL_TOKEN`, which
is what unlocks empty-DB first signup on Docker (the API peer is the dashboard container,
not loopback). After that account exists, public signup stays disabled — invite teammates
from **Settings → Team**.

If you prefer not to use the web form, you can also mint the first admin with the same
token the CLI uses:

```bash
docker compose exec api bun -e '
  const token = process.env.INTERNAL_TOKEN;
  const res = await fetch("http://127.0.0.1:4000/api/system/bootstrap-admin", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": token },
    body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "changeme-please" }),
  });
  console.log(await res.json());
'
```

---

## Users & access (self-hosted)

- **Public signup is disabled.** The first admin is created by the `openship` setup wizard, the Docker dashboard signup on a fresh install, or `POST /api/system/bootstrap-admin` with `INTERNAL_TOKEN`.
- **Invite teammates** from **Settings → Team**. They get an accept link at your instance's URL (so the instance needs to be reachable — a public URL or your LAN).
- **Lost the admin password?** Run `openship reset-admin-password` on the box (no sign-in needed; uses the local internal token).

---

## CLI reference

### Run & manage the instance
| Command | Does |
|---|---|
| `openship up [--foreground]` | Start Openship as a service (boot + auto-restart); `--foreground` runs it attached |
| `openship up --public-url <url> [--managed-edge]` | Serve the dashboard at a public domain (+ install OpenResty/TLS with `--managed-edge`) |
| `openship stop` | Stop the service |
| `openship status [--json]` | Is it running? Resolved ports + API health |
| `openship open` | Open the dashboard in your browser |
| `openship update` | Update the CLI + bundled server to the latest release |
| `openship reset-admin-password` | Reset the local admin login on this machine (no sign-in) |
| `openship install` | Download the desktop app for this OS |
| `openship doctor` | Diagnose the CLI setup (config, context, runtime) |

### Deploy & inspect
| Command | Does |
|---|---|
| `openship init` | Link the current directory to a project (`.openship/project.json`) |
| `openship deploy` | Trigger a deployment for the current project |
| `openship logs <deploymentId> [-f] [--tail N]` | View or stream a deployment's logs (`-f` = live) |
| `openship deployment` | List / manage deployments |
| `openship project` | List / manage projects |
| `openship service` | Services within a stack |
| `openship domain` | A project's domains |

> Health + logs for the control plane itself: `openship status`, and `openship logs <openship-app-deployment-id>` streams the running instance's own logs (Openship is a real app — find its deployment id under Apps → Openship → Deployments).

### Infrastructure & admin
| Command | Does |
|---|---|
| `openship server` | Manage self-hosted SSH servers |
| `openship system` | Read / update instance settings |
| `openship mail` | Mail server setup |
| `openship backup` | Backup policies (schedules) for a project |

### Auth, config & automation
| Command | Does |
|---|---|
| `openship login` / `logout` | Authenticate with a Personal Access Token (create one in dashboard Settings) |
| `openship context` | Manage contexts — which instance the CLI talks to |
| `openship token` | Manage personal access tokens |
| `openship api <method> <path>` | Authenticated request to any API route (like `gh api`) |

Add `--json` to most read commands for scripting.

---

## Quick decision

- **Just you, private** → Desktop app.
- **Team / always-on / public / CI** → `openship up --public-url https://… --managed-edge` on a server.
- **No ops at all** → Openship Cloud.
