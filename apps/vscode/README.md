# Openship for VS Code

Browse Openship projects, deploy a remote Git branch, and follow build and application logs from the editor. This extension connects to an existing Openship API through the shared SDK.

## Install locally

From the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd apps/vscode package
code --install-extension apps/vscode/dist/openship-vscode-0.8.0.vsix
```

Requires VS Code 1.105 or later, which provides the Node 22 extension host required by the SDK. Build tooling uses the repository's existing Node, TypeScript, esbuild, and Vitest versions. The extension version matches the current Openship release; this change does not bump the platform version.

## Connect and deploy

1. Open **Openship** in the Activity Bar, or run **Openship: Connect** from the Command Palette.
2. Enter a connection name, API URL, dashboard URL, optional organization ID, and personal access token. Create the token in your Openship dashboard's Settings. Project read access is required to connect; deployments and their controls also require the appropriate write permissions.
3. Run **Openship: Link Workspace to Project**, or right-click a project in the sidebar. Select the workspace folder and the existing Openship project.
4. Push your changes to your Git remote, then run **Openship: Deploy Git Branch**. Select the remote branch and review the target project, connection, and variable set before deploying.
5. Read progress in the **Openship** Output channel. Click a deployment to watch it, or right-click a project to show application logs or open its dashboard/application.

**Stop Watching Logs** closes the subscription. The deployment keeps running. **Cancel Deployment** explicitly requests cancellation from Openship and distinguishes a pending cancellation from a completed one.

Deployments that need a decision offer **Respond**. Decisions such as accepting a deployment without an interactive prompt open the dashboard. Failed, partially failed, cancelled, rejected, and unchanged deployments retain their actual status.

The sidebar shows every accessible project and the latest 50 deployments per project. Older deployments are available in the dashboard. Use **Refresh Projects** after changes made outside the editor.

## Connections and workspace links

Tokens are kept in VS Code SecretStorage. Non-secret connection profiles are kept in extension storage. Profiles are independent of the CLI's authentication and active context; the extension does not change `~/.openship/config.json`.

The extension reads and writes the CLI-compatible `.openship/project.json` project link, including links in a parent directory. The first use of an existing CLI link asks which saved connection owns it. That association is stored per workspace folder, with the project and organization identity. Editing the link requires selecting its connection again. Removing a connection does not silently remap existing workspace links to another server.

Each folder in a workspace can link to a different project. The extension refuses native CLI instance links until you explicitly relink the folder to a project on an HTTP connection.

Restricted workspaces can browse projects and logs through an explicitly selected connection. Linking, deploying, cancelling, and responding require Workspace Trust. Repository link files are not used while a workspace is restricted.

Under Remote SSH or Dev Containers, the extension runs in the workspace's extension host. `localhost` in the API URL refers to that host; use an address reachable from it. Browser-only virtual workspaces are unsupported.

## Configuration editing

Files named `openship.json` receive completion, descriptions, and validation from the existing Openship JSON schema. The build copies `apps/web/public/openship.schema.json` into the VSIX, so there is a single schema source and validation works offline.

## Scope of this release

- Deploy existing projects connected to GitHub, GitLab, or Bitbucket. Local edits must be pushed before a Git deployment.
- Select an existing project/environment. A preview variable set does not create a new isolated runtime; the selected project determines the deployment target.
- Uploading local folders, creating projects/environments, rollback controls, and embedding the native Openship engine are outside this release.
- Updating a token, removing a connection, switching log views, and deactivating the extension dispose the previous log subscription.

## Development and verification

```sh
bun run --cwd apps/vscode lint
bun run --cwd apps/vscode test
bun run --cwd apps/vscode build
bun run --cwd apps/vscode test:host
bun run --cwd apps/vscode package
```

`test:host` downloads the minimum supported VS Code version and runs an actual extension host against a temporary workspace and user profile. It checks activation, command registration, the Node runtime, and schema diagnostics. On headless Linux, run it with `xvfb-run -a`. Set `OPENSHIP_VSCODE_EXECUTABLE` to use an existing VS Code executable, or `OPENSHIP_EXTENSION_PATH` to test an unpacked VSIX. Tests do not use a real Openship account or trigger production deployments.

To debug interactively:

```sh
bun run --cwd apps/vscode dev
code --new-window --extensionDevelopmentPath="$PWD/apps/vscode"
```

The extension bundles `@repo/sdk/client`. VS Code supplies the `vscode` module; no CLI installation, native database, or running engine is packaged into the extension. The VSIX allowlist includes only the manifest, bundle, schema, icons, documentation, and license.
