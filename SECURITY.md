# Security Policy

OpenShip welcomes good-faith security research. This policy explains how to
report a suspected vulnerability, which OpenShip boundaries are supported, and
how maintainers evaluate reports.

OpenShip is a deployment control plane. Depending on how it is used, it can
hold source-provider tokens, application secrets, SSH credentials, deployment
authority, backups, domain and TLS configuration, and access to production
servers. A useful report identifies the OpenShip trust boundary that was
crossed, not only a dangerous capability that a trusted operator deliberately
enabled.

## Report a security issue

OpenShip uses **public disclosure** for security reports. Open a
[GitHub issue](https://github.com/oblien/openship/issues/new?title=%5BSecurity%5D%20)
in this repository and prefix the title with `[Security]`. If you are unsure
which OpenShip component owns the issue, use the same issue tracker and the
maintainers will route it. This public issue tracker is the authoritative
reporting path; OpenShip does not currently offer a separate private intake
channel.

Reports, triage, and follow-up are public from the time the issue is filed.
Provide enough sanitized detail to reproduce the problem, but never include:

- live credentials, tokens, private keys, or session material;
- customer, tenant, or other third-party data;
- private infrastructure details that are not necessary to demonstrate impact;
  or
- destructive payloads or persistence mechanisms.

Use test credentials, synthetic data, and infrastructure you own. If evidence
contains sensitive values, replace them with clearly marked placeholders and
explain how a maintainer can reproduce the evidence safely. Maintainers may
edit, hide, or remove content that exposes live secrets or third-party data
while keeping the security report and its resolution public.

## Supported versions

Security fixes target the latest published release and current `main`. Older
releases, forks, and downstream packages do not receive a guaranteed security
backport or long-term-support window. A report against an older version should
also show that the issue reproduces on the latest release or current `main`.

## In-scope assets

The following OpenShip-maintained surfaces are in scope when tested under the
rules in this policy:

- the source in `oblien/openship`, including the API, dashboard, website and
  documentation application, desktop application, CLI, email functionality,
  and packages used by those applications;
- the official `openship` npm package;
- official installers, desktop builds, server/dashboard bundles, checksums, and
  other artifacts published through OpenShip's GitHub Releases and release
  workflows;
- OpenShip's GitHub App/OAuth integration and OpenShip webhook handling;
- OpenShip-operated services at `openship.io`, `app.openship.io`,
  `api.openship.io`, and `get.openship.io`; and
- OpenShip-managed deployment and routing surfaces under `*.opsh.io`.

Hosted-service testing is permitted only with accounts, organizations,
projects, repositories, domains, workloads, and data that you own or have
explicit permission to test. The presence of an OpenShip component on a host
does not authorize testing that host.

Third-party providers and user-managed deployment targets are not OpenShip
assets. This includes GitHub, Oblien, Stripe, cloud providers, DNS and ACME
providers, SMTP providers, object storage, SFTP/SSH servers, package registries,
custom domains, and customer servers. A bug in OpenShip's use of one of those
systems can be in scope, but do not test the third party or another user's
infrastructure without its owner's permission.

## Security model and trust boundaries

### OpenShip Cloud

OpenShip Cloud is an Internet-facing, multi-user, multi-organization control
plane. Authentication, organization and role authorization, resource grants,
tenant data separation, cloud workspace separation, credential confinement,
and isolation between customer builds and workloads are security boundaries.

A user, repository contributor, build, or deployed workload must not gain
access to another organization, another project's secrets or artifacts, the
OpenShip control plane, shared cloud infrastructure, or broader provider
authority than the operation requires.

### Self-hosted installations

The person or organization operating a self-hosted instance controls its host,
database, Redis instance, filesystem, environment, reverse proxy, Docker
daemon, SSH configuration, and injected secrets. Host administrators and root
users are trusted for that installation. A person who can modify OpenShip's
process environment, database, configuration, binaries, or service account is
also inside the trusted operator boundary.

OpenShip authorization between ordinary users, roles, organizations, and
resources remains a product boundary. A remote attacker or lower-privilege user
reaching administrator, terminal, backup, secret, or deployment capabilities is
reportable even on a self-hosted instance.

Operators are responsible for host hardening, network exposure, TLS and
reverse-proxy configuration, Docker daemon security, SSH account privileges,
filesystem permissions, database and Redis exposure, and secret management.
Misconfiguration can still motivate documentation or hardening work, but is
not by itself an OpenShip vulnerability.

### Deployment and build execution

Repository source, branches, Dockerfiles, Compose files, package scripts,
framework configuration, build/start commands, paths, archives, and workload
output are untrusted input. Authorized builds and deployments intentionally run
project code.

- In cloud and Docker modes, project code must not escape its intended
  workspace or container to reach control-plane credentials, the host, sibling
  workloads, another tenant, or infrastructure authority.
- In bare mode, OpenShip intentionally runs authorized project commands as host
  processes. Execution of the selected build or start command is expected. A
  report must demonstrate an unexpected expansion beyond the configured host,
  service account, project, organization, or secret boundary.
- A project may read its own intentionally injected environment variables and
  serve arbitrary content. It may not read other projects' or organizations'
  secrets, source, logs, backups, or runtime state.
- A compromised deployment target is not trusted as an OpenShip control-plane
  principal. An OpenShip flaw that lets it reuse retained credentials, pivot
  into the control plane, or affect other targets is in scope.

### API, clients, and integrations

Browser sessions, personal access tokens, MCP OAuth grants, CLI credentials,
and desktop internal tokens must receive only their documented permissions and
organization/resource scope. An identifier supplied by a caller is never proof
of authorization.

Public webhooks and callbacks must pass their documented signature, capability,
state, replay, and tenant-binding checks before they trigger a privileged
action. Authentic provider data is still untrusted input.

The desktop application's local OS account and Electron main process are
trusted. Its loopback-only services, internal token, renderer isolation,
navigation controls, updater, and IPC surface remain boundaries: remote or web
content must not turn renderer access into unauthorized API, filesystem, or OS
execution.

## Findings normally in scope

Examples include:

- authentication bypass, session compromise, or account takeover caused by
  OpenShip;
- cross-organization or cross-project access to customer data, source code,
  secrets, logs, backups, deployments, mail, domains, or infrastructure;
- privilege escalation from a member, restricted role, read-only token, or
  resource-scoped token to a more privileged action;
- command injection, build escape, container/workspace escape, or arbitrary
  code execution beyond an intended execution boundary;
- exposure or misuse of GitHub, SSH, cloud, backup, SMTP, webhook, session, or
  deployment credentials;
- server-side request forgery that reaches protected OpenShip, cloud metadata,
  provider, internal-service, or cross-tenant resources;
- webhook signature, replay, idempotency, or repository/organization binding
  failures with a demonstrated privileged effect;
- path traversal, symlink or archive extraction escape, unsafe restore/import,
  or file handling that reaches data outside the authorized project or root;
- authorization failures in server terminals, service terminals, tunnels,
  backups, restores, instance import/export, billing, or destructive actions;
- route, domain, certificate, proxy, mail, or generated-configuration flaws that
  cross a tenant or infrastructure boundary;
- a vulnerability in an official installer, update path, release workflow,
  published package, desktop build, or release artifact; and
- unauthenticated or low-privilege resource exhaustion with meaningful,
  repeatable impact on a shared service or other tenants.

## Findings normally out of scope

The following are usually bugs, hardening suggestions, or expected behavior
unless the report demonstrates a separate supported-boundary bypass:

- an owner or administrator using capabilities that role is documented to
  have;
- behavior requiring prior root/administrator access, control of the trusted
  host, or modification of OpenShip's trusted configuration, environment,
  database, binaries, or local state;
- an authorized bare-mode project running its configured install, build, start,
  or custom command on its target host;
- a project reading its own explicitly injected secrets, writing its own
  workspace, or serving malicious content selected by its owner;
- unsafe mounts, raw SSH options, exposed services, weak credentials, disabled
  controls, public network exposure, or other risks intentionally introduced by
  a trusted operator contrary to documented guidance;
- compromise or ordinary behavior of a third-party provider, dependency,
  container engine, image, helper binary, source repository, or user-managed
  server without an OpenShip-specific boundary failure;
- reports against unsupported releases, forks, modified builds, test fixtures,
  demos, examples, or maintainer-only development tools that are not shipped or
  reachable from a supported production surface;
- scanner output, dependency-version matches, version banners, missing headers,
  or theoretical concerns without a reproducible OpenShip-specific impact;
- exposed credentials that are not OpenShip-owned and do not grant access to an
  OpenShip-operated asset, unless OpenShip disclosed them across another
  supported boundary;
- self-denial-of-service by a trusted operator or project, minor rate-limit
  variation, or availability claims without meaningful amplification,
  persistence, or impact outside the reporter's own resources;
- social engineering, phishing, physical attacks, credential stuffing, and
  brute-force testing; and
- reports whose only impact is cost, orphan cleanup, observability, or a
  defense-in-depth improvement without a confidentiality, integrity,
  authorization, isolation, or material shared-availability impact.

If you are unsure whether a finding crosses a supported boundary, file a
sanitized public issue and explain the boundary you believe is affected.

## What to include in a report

High-signal reports include:

1. A concise description of the vulnerability and why it is security-relevant.
2. The affected component, deployment mode, version, and commit SHA.
3. The attacker's required access, role, configuration, and other prerequisites.
4. Exact reproduction steps or a minimal proof of concept using test data.
5. The observed result and expected secure result.
6. The concrete impact, affected assets, and OpenShip boundary crossed.
7. Relevant source locations, logs, requests, responses, screenshots, or traces
   with secrets and third-party data removed.
8. Suggested remediation or a focused patch, when available.

For a released-version claim, reproduce against the published artifact or
package for that version. For a dependency report, show that the exact shipped
version is affected and that the vulnerable behavior is reachable through
OpenShip with demonstrated impact. Scanner output alone is not a reproduction.

## Safe testing rules

Prefer a local, disposable OpenShip installation. When testing an
OpenShip-operated service:

- use only accounts, organizations, projects, repositories, domains, workloads,
  credentials, and data you own or are explicitly authorized to test;
- keep requests low-volume and stop as soon as the issue is demonstrated;
- use the least destructive proof possible and synthetic data;
- do not access, modify, retain, or disclose another user's data;
- do not establish persistence, alter credentials, deploy malware, pivot to
  other systems, or continue after obtaining unintended access;
- do not perform denial-of-service, load, stress, rate-limit, broad automated
  scanning, brute-force, or credential-stuffing tests;
- do not test employees, customers, social channels, physical facilities, or
  third-party services; and
- comply with applicable law and the terms of any third-party system involved.

If you unexpectedly encounter third-party data or access, stop testing,
discard any retained copy, and report only the minimum sanitized information
needed to identify the affected boundary. This policy authorizes no testing of
third-party assets and cannot bind third parties.

## Triage, disclosure, and credit

OpenShip's response targets are best-effort:

- acknowledgement or first maintainer response within **3 business days**;
- an initial scope and severity assessment within **10 business days**; and
- a status update at least every **14 days** while a validated report remains
  unresolved.

Complex fixes, release coordination, and maintainer availability may affect
these targets. Severity is based on demonstrated impact, attacker
prerequisites, affected deployment mode, credential scope, number of affected
organizations, and whether the behavior crosses a promised boundary. The same
primitive may have different severity in OpenShip Cloud, self-hosted Docker,
bare-mode, and desktop deployments.

For duplicates, maintainers generally keep the earliest clear, reproducible
report as the canonical issue and link later reports when useful. Reporters who
contribute materially may be credited in the issue, release notes, GitHub
Security Advisory, or CVE record with their consent. Advisory and CVE
publication are determined case by case after validation and remediation.

OpenShip does **not** currently operate a paid bug bounty and does not guarantee
payment or other rewards. Public recognition is discretionary and depends on
the quality and originality of the report.
