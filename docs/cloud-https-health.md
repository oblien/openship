# Cloud HTTPS verification

Cloud certificate metadata is checked against the namespace, project-owned Page
and exact custom hostname. An active provider status alone is not HTTPS proof:
Openship also opens TLS to the public hostname with its exact SNI and verifies the
trusted chain, hostname and validity dates. The connection sends no HTTP request,
credentials or redirects. The shared outbound-target guard validates DNS once
and pins the selected public IP, with a five-second total DNS/handshake deadline.

The check runs through existing certificate verification, after renewal and in
both deployment pipelines' final TLS audit. A renewal accepted by the provider
remains provisioning until a valid certificate is observed. A known mismatch is
reported through the existing domain status and monitoring issue; a network
failure is an unknown observation and preserves the certificate's last known
state, including a pending issuance.

`domains:check-https` runs every five minutes through the normal Jobs system.
It selects at most 25 due Cloud custom domains, with three concurrent workers,
persisted failure backoff and eligibility rechecked under the project lock.
Deleted/disabled/draft projects, inactive services, free hostnames, literal
wildcards and externally managed certificates are excluded. Operators can manage
the job through the existing job controls; no network checks run on page render.
Domain details use the earliest enabled check's schedule and failure backoff,
including the existing pending-certificate sweep. A retained active certificate
can still be checked automatically after an unavailable observation.

This job only verifies. It never removes/recreates routes, restarts workloads or
requests certificates. The existing pending-certificate sweep does not issue a
new certificate when a provider-issued certificate is served incorrectly or the
observer cannot connect. Explicit renewal retains the existing ownership checks
and issuance locks. Provider certificate binding/SNI problems still require the
provider to repair its edge.
