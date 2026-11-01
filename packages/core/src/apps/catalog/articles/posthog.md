## Product analytics on your infrastructure

PostHog combines event ingestion, product analytics, session replay, and feature flags. Use it to understand application usage and explore interactions with a feature after release.

The template follows the upstream hobby topology. It includes 21 services: databases, ingestion workers, caching, storage, a path router, and the application.

## Choose capacity for the whole deployment

The catalog describes a workload of roughly 4 vCPU, 16 GB RAM, and more than 30 GB disk. Its images follow moving upstream builds. This configuration is not a supported high-availability production topology.

Review the [source project](https://github.com/PostHog/posthog) and current self-hosting guidance before using it for important workloads.
