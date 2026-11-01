# Static hosting on managed Cloud

New deployments of single-app static source projects default to **Cloud Pages**.
The selected managed server builds in a Docker sandbox. Openship extracts the
output, publishes a copy through Cloud Pages, and removes the build image and
extraction container. No nginx application container remains running for the site.
The managed server itself is retained: other applications may use it, and it
holds source/build caches and retained release files for rollback. This change
does not introduce a shared build pool or stop a customer's server.

Choose **Managed server** in the Cloud deployment settings to serve static output
from an nginx container instead. The same choice is available in the project's
advanced static-hosting settings. Saving it takes effect on the next deployment;
it does not move the currently active deployment.

Self-hosted static projects continue to serve files directly through their edge.
Server-rendered apps, workers, Compose services, and prebuilt runtime images keep
their existing execution paths.

Each new deployment records its hosting choice. Restoring an older deployment
uses that deployment's saved runtime and artifact, including older nginx-based
releases. Pages publication must succeed before the previous workload is retired.
A publication failure keeps the previous workload available and reports failure.
The Pages adapter restores the previous exported files if route activation fails.

## Release verification

1. Apply migration `0168_cloud_static_hosting` and deploy the API and dashboard.
2. Deploy an isolated static test project with Cloud Pages selected. Confirm its
   public page and assets, a Pages static route, and no running app container.
3. Verify the page remains available when the test build container is gone.
4. Publish a second version and restore the first; verify actual page content.
5. Switch to Managed server and redeploy, then switch back. Verify the hostname
   stays the same and the previous container is retired only after publication.
6. Verify a custom domain and routing rules. A missing-route response can have
   HTTP status 200, so status checks alone are insufficient.

Automated tests use an in-memory provider and do not establish CDN performance
or availability during provider outages. Confirm the provider path with an
isolated Cloud smoke deployment before migrating customer sites.
