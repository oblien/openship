## An in-memory layer for your stack

Valkey supports Redis-compatible clients for caching, sessions, rate limits, and queues. The template includes Valkey and RedisInsight, with the web interface connected to the instance.

## Connect from an application

Use the connection information provided by the install flow. A remote client needs a reachable endpoint or tunnel; exposing a data port is a separate choice from publishing the web dashboard.

Persistence and backup requirements depend on whether the instance holds disposable cached data or records your application needs to recover. Read the [Valkey documentation](https://valkey.io/) when choosing the configuration for your workload.
