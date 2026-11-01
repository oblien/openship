## Postgres branches for development

This template packages self-hosted Neon through the community `neond` control plane. It provides branching, a browser console, and per-branch connection strings.

The community control plane bundles Neon's database components into one service. It is separate from Neon's proprietary hosted console. See the [neond source project](https://github.com/matisiekpl/neond) for its implementation.

## Understand the template's limits

The catalog describes this as a development and preview configuration. It has one container, no high-availability topology, a substantial image, and fixed host ports for branch endpoints.

Review those constraints and the template settings before choosing it for an important database workload.
