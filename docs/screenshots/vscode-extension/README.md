# VS Code extension live test

These screenshots show the packaged Openship extension in VS Code 1.139.1,
connected to a real authenticated local Openship API. They were captured on
September 28, 2026; the deployment and application logs are from the running
Node fixture, with no mocked API responses.

| Screenshot                                                    | Verified behavior                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [Deploy confirmation](01-deploy-confirmation.png)             | Reviews the connection, API, project, remote branch, and variable set before deploying.                |
| [Deployment ready](02-deployment-ready.png)                   | Follows deployment output through the port check and final `ready` status.                             |
| [Application logs](03-application-logs.png)                   | Streams the running application's `listening on 33531` log into VS Code.                               |
| [History and stopped log watch](04-history-and-stop-logs.png) | Shows ready, failed, and cancelled deployment history after stopping the application log subscription. |

The successful deployment used the existing native process runtime with
`DEPLOY_MODE=bare`, `OPENSHIP_NATIVE=true`, and `OPENSHIP_NATIVE_ROUTING=none`.
Its source was `oblien/openship` at `f1470f7e5387d52c6387ee0119631f0243269f53`,
started with `node fixtures/deploy/node/server.js`. Separate HTTP and process
checks confirmed that `http://127.0.0.1:33531` returned `hello from node` with
status 200 and that stopping log watching preserved the running process.

The Docker attempt failed because the host could not create bridge `veth`
interfaces. The successful process deployment had no public URL; public URL
opening, TLS, remote/cloud deployments, and interactive deployment decisions
were not exercised live. The repository-relative start command worked around
the fixture's startup-directory behavior; that behavior is unchanged by this PR.

The captures precede the rebase onto main at
`5b80c63ddab80c6d46cd0f58c72fe75c10211531`. The rebase preserved the extension
implementation and the two fixes discovered during live testing. Only these
four selected images are tracked here; the complete local test state remains
outside Git. These documentation images are not included in the VSIX.
