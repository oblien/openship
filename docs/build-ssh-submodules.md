# Private submodules pinned to SSH aliases

Some repos keep `.gitmodules` on SSH URLs with a host alias per submodule
(`git@gh-backend:owner/repo.git`, `git@gh-fluticon:owner/other.git`). That is a
deliberate security choice: each private submodule has its own read-only deploy
key, and GitHub rejects offering several keys for one `github.com` host.

OpenShip's api-host build clone authenticates only the **parent** repo with a
scoped HTTPS token. In token mode Git is deliberately HTTPS-only
(`GIT_ALLOW_PROTOCOL=https`, `protocol.allow=never`) so the token cannot be sent
to another host, and same-owner token expansion only understands
`github.com` URLs. The result on an SSH-alias repo is:

```
fatal: transport 'ssh' not allowed
fatal: clone of 'git@gh-backend:owner/repo.git' into submodule path '…' failed
```

Changing `.gitmodules` to HTTPS is not an option for these deployments (it
changes the dev-machine workflow and weakens the per-submodule key separation),
so the build clone can instead use an **operator-provided build SSH identity**.

## Enable it

1. Create a directory readable by the API container containing:

   ```
   <dir>/config           # ssh_config with the per-repo Host aliases
   <dir>/known_hosts
   <dir>/id_ed25519_*     # the read-only deploy keys referenced by config
   ```

   `config` uses container-side paths, for example:

   ```
   Host gh-backend
     HostName github.com
     HostKeyAlias github.com
     User git
     IdentityFile /root/.ssh/id_ed25519_backend
     IdentitiesOnly yes
   ```

2. Add the host path to the compose stack's `.env`:

   ```sh
   OPENSHIP_BUILD_SSH_DIR=/home/openship/.ssh-build
   ```

   (It can also be exported for a one-off `openship up`.)

3. Run `openship up` / `openship update`. The compose generator mounts the
   directory **read-only** at `/root/.ssh` in the api service and sets
   `OPENSHIP_BUILD_SSH_DIR=/root/.ssh` there.

The mount and the SSH transport are only enabled when the directory exists and
contains a regular `config` file. Unset or missing → the previous HTTPS-only
behaviour, unchanged.

## What the clone does

`packages/adapters/src/runtime/git-clone.ts`:

- still clones the **parent** over HTTPS with the App/PAT token and the scoped
  credential helper;
- when a build SSH identity is configured AND the clone runs on the API host,
  adds `protocol.ssh.allow=always` and `GIT_ALLOW_PROTOCOL=https:ssh`, sets
  `GIT_SSH_COMMAND="ssh -F <dir>/config -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o BatchMode=yes"`,
  and leaves SSH submodule URLs alone instead of rewriting them to HTTPS.

The identity is resolved by each clone's caller and **only for clones that
execute on the API host** — the container the compose renderer mounts the
directory into. A build that clones elsewhere never sees it: an SSH server
build clones on the target server, and a cloud build runs in the provider
workspace — neither has the `/root/.ssh` mount, so their clone commands must
not reference it (they keep the HTTPS-only behaviour, unchanged).

The token is never placed in the SSH path and the SSH keys are never placed in a
clone URL or Git config. The directory is mounted read-only; the API already
holds the Docker socket and the host-control key on a compose install, so this
is not a new trust boundary on those hosts. On a multi-tenant self-hosted box,
only mount a directory whose keys are scoped to the repos those builds may read.

## Guard

`scripts/fork/patch-guard.mjs` (patch 10) checks that the code, the compose
mount/env and the `.env.example` documentation survived an upstream merge.
