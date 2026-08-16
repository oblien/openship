# Mounted releases

Mounted releases separate application code from its runtime image:

- **Deploy code** fetches the selected Git branch on the target server, prepares
  a new immutable release, atomically moves `current`, reloads the app, and runs
  the configured health check.
- **Rebuild runtime** uses the normal OpenShip pipeline. Use it for Dockerfile,
  base-image, extension, container-command, or mount changes.

OpenShip keeps separate active pointers for those lanes. A code deploy therefore
does not replace the container/image identity used by logs, routing, restarts,
or runtime rollback.

## Host layout

For project `proj_123`, OpenShip owns:

```text
/var/lib/openship/mounted-releases/proj_123/
  current -> releases/dep_...
  releases/dep_.../
  shared/
  source.git
```

The stable project directory is mounted at the configured container release
root. The application must serve or start from `<container root>/current`.

## First activation

1. Open **Runtime → Mounted releases**.
2. Choose the app service for a compose project.
3. Set the repo source directory and container release root.
4. Choose **Prebuilt in Git** when generated assets are committed, or **Prepare
   on server** when the release still needs an install or build command.
5. Save, then run **Rebuild runtime** once to attach the stable mount.
6. Use **Deploy code** for normal source changes.

## Prebuilt repositories

Use **Prebuilt in Git** when the selected commit already contains everything
the running application needs. OpenShip fetches and extracts the commit, flips
`current`, reloads the application, and checks health. It does not start a
builder or run package-manager commands on the server.

## Compiled applications

Choose **Prepare on server** when the production image is intentionally small,
then set a **Builder image** with the prepare command. OpenShip mounts the staged checkout at `/workspace`
inside a disposable builder on the target server, runs the build, and removes
the builder before activation. The live container never needs compilers or
development dependencies.

For example, a static Node application can use:

```text
Builder image: node:20-alpine
Prepare release: npm ci --no-audit --no-fund && npm run build:static
```

Builder memory and CPU default to 1024 MB and 1 core and can be adjusted per
project. A persistent project-local builder cache is mounted at `/cache`; use it
for package-manager downloads, lockfile-keyed dependencies, and compiler caches.
Builder cache paths can also mount repo-relative directories directly into the
checkout. For Node projects, `node_modules, .next/cache, .npm` supports a
lockfile marker in the prepare command without copying dependencies per release.
Leaving Builder image blank preserves the original behavior: the prepare
command runs inside the staged release in the live app container.

The first code deploy refuses with a clear error if the running container does
not have the mount. It never silently switches a host directory the container
cannot see.

## Persistent paths

A plain entry such as `storage` is managed under OpenShip's `shared/` directory.
To preserve an existing container data mount, point the release path at it:

```text
storage=/var/www/html/storage
database=/var/lib/my-app
```

This creates a symlink inside every release; it does not copy or replace the
existing data volume.

## Failure and rollback

The previous `current` target is remembered during activation. If reload or the
health check fails, OpenShip swaps back and reloads the previous release. Code
deployments appear in normal history with a **Code** lane badge; runtime builds
show **Runtime**. Restoring an older code release creates a new mounted release
from that commit, so the same prepare and health gates apply.
