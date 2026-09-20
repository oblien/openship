# Shared platform

Transport-independent application operations. `createAuthorization` owns the existing role/grant policy through injected repository and cloud-link ports. `createPlatform` composes deployment creation with the existing engine, presenter, external gateway, and audit sink.

Operations accept an internal `ExecutionContext` and return `{ context, data }`. The returned context contains the resolved tenant and current membership; HTTP can rebind its request state, while a native SDK scope exposes only `data`. Public callers enter through `@repo/sdk` and a trusted identity adapter. Raw context constructors and permission overrides are composition internals, not a public authentication mechanism.

This package does not import Hono, a database singleton, infrastructure initialization, the SDK, or application code. Creation is passive. The API currently supplies the engine and its runtime ownership in [its composition module](../../apps/api/src/lib/platform.ts). Full instance lifecycle isolation is still pending.

See [SDK usage and supported scope](../sdk/README.md) and the [migration plan](../../docs/ship-sdk-plan.md).
