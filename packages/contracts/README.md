# Application contracts

Shared runtime schemas and public data types for the SDK, platform, and HTTP adapters. The initial surface covers deployment creation and fixed-tenant protocol discovery. Contracts have no database, Hono, provider, or application dependencies.

`parseCreateDeploymentInput` snapshots and validates public fields. Unknown fields are ignored for existing HTTP compatibility; internal deployment-engine arguments are not part of this contract.

Deployment result types are inferred from runtime schemas. `isCreateDeploymentResult` validates the same response in the remote SDK and cloud gateway, including agreement between the envelope IDs and any full deployment record. ID-only responses remain supported, so `deployment` is optional in the common result type; a supplied record must be complete. The API composition also validates its masked, serialized presentation with `isDeployment`.

See [SDK usage](../sdk/README.md) and the [migration plan](../../docs/ship-sdk-plan.md).
