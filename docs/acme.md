# Custom ACME certificate authorities

OpenShip uses Certbot on the managed OpenResty edge. With no ACME configuration,
certificate issuance and renewal continue to use Let's Encrypt production.

Set the following variables in the environment used to start OpenShip, then
restart the API/control plane:

```dotenv
OPENSHIP_ACME_EMAIL=ops@example.com
OPENSHIP_ACME_DIRECTORY_URL=https://acme.example.com/directory
OPENSHIP_ACME_EAB_KID=example-key-id
OPENSHIP_ACME_EAB_HMAC_KEY=base64url-encoded-hmac-key
OPENSHIP_ACME_KEY_TYPE=ec256
OPENSHIP_ACME_TOS_AGREED=true
```

`OPENSHIP_ACME_EAB_KID` and `OPENSHIP_ACME_EAB_HMAC_KEY` are optional, but they
must be supplied together. OpenShip never places the HMAC key in Certbot's
command line or streamed logs. It writes the pair to a unique mode-`0600`
Certbot configuration file for the issuance process and deletes that file when
the process exits. Keep the source value in a protected environment/secret store.

Because that file is passed with Certbot's `--config` flag, an operator-managed
`/etc/letsencrypt/cli.ini` is ignored for EAB issuance runs. If you rely on
custom `cli.ini` settings, express them through the `OPENSHIP_ACME_*` variables
instead.

Supported certificate key choices are `ec256`, `ec384`, `rsa2048`, and
`rsa4096`. When omitted, Certbot's installed-version default is preserved.

## Let's Encrypt

No custom settings are required. For staging tests, add:

```dotenv
OPENSHIP_ACME_DIRECTORY_URL=https://acme-staging-v02.api.letsencrypt.org/directory
```

## ZeroSSL

Create EAB credentials in ZeroSSL, then configure its production directory:

```dotenv
OPENSHIP_ACME_EMAIL=ops@example.com
OPENSHIP_ACME_DIRECTORY_URL=https://acme.zerossl.com/v2/DV90
OPENSHIP_ACME_EAB_KID=your-zerossl-kid
OPENSHIP_ACME_EAB_HMAC_KEY=your-zerossl-hmac-key
OPENSHIP_ACME_TOS_AGREED=true
```

The HMAC value must remain in the base64url form supplied by the CA; do not
decode it before configuring OpenShip.

## Private CA and custom trust root

For a private ACME server such as `step-ca`, point OpenShip at the directory and
make its root certificate visible in the environment where Certbot runs:

```dotenv
OPENSHIP_ACME_DIRECTORY_URL=https://ca.internal.example/acme/provisioner/directory
OPENSHIP_ACME_EAB_KID=provisioned-key-id
OPENSHIP_ACME_EAB_HMAC_KEY=provisioned-base64url-key
OPENSHIP_ACME_CA_BUNDLE=/etc/ssl/private/acme-root.pem
```

On a bare Linux edge, the bundle path is a normal absolute host path. When the
edge runs in a container, the same absolute path must be mounted read-only into
the `edge` container. For the repository Compose stack, use an override:

```yaml
services:
  edge:
    volumes:
      - /secure/acme-root.pem:/etc/ssl/private/acme-root.pem:ro
```

Certbot uses `REQUESTS_CA_BUNDLE` for issuance and renewal. The bundle therefore
needs to contain the private root plus any public roots needed by the ACME
endpoint's chain.

## Switching certificate authorities

Certbot records the issuing directory per certificate, and a certificate issued
by one CA cannot be renewed against another (the new CA requires its own
account, and usually its own EAB credentials). When the configured directory
differs from the one that issued a certificate, OpenShip reissues that
certificate under the newly configured CA at its next renewal instead of
renewing it — a one-time reissue per domain, after which normal renewal
resumes. Existing certificates keep serving traffic until that happens.

## Current scope

These settings define one instance-wide CA. Persistent named CA profiles and
per-project/per-domain overrides require a database and API design and are not
yet exposed by the dashboard or CLI.
