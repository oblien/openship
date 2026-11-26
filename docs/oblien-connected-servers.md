# Connect a customer-owned Oblien VM

In **Servers → Add server**, choose the connected-server option. **Connect an existing VM** opens the customer's Oblien account. **Get a VM from Oblien** opens its custom pricing flow first. The customer selects one VM and consents to read and runtime access. If needed, its owner can explicitly enable the Runtime API. A running VM with a working Runtime API is required to attach. Docker deployments also require Docker installed on the VM.

The compute purchase, invoices and VM lifecycle belong to the customer in Oblien. The server counts against the organization's existing connected-server management allowance. Managed Cloud uses its existing purchase and deployment flow.

## Configure the integration

1. Sign in to the publisher’s Oblien account and register an application through Settings → Registered applications or `POST /v2/oauth/apps`. For the hosted OpenShip installation the publisher is account 80. Register the exact HTTPS dashboard callback ending in `/connections/callback` and the scopes `vm.read` and `vm.runtime`. A self-hosted installation registers its own client. An Oblien operator can assign the approved OpenShip icon with `scripts/register-oauth-app.ts --owner-account ACCOUNT_ID --client-id APP_CLIENT_ID --icon openship`.
2. Store its client ID and secret in the OpenShip API secret store as `OPENSHIP_CONNECTION_OBLIEN_CLIENT_ID` and `OPENSHIP_CONNECTION_OBLIEN_CLIENT_SECRET`. The dashboard uses the existing provider-availability endpoint.
3. Apply OpenShip migration `0236_oblien_connected_servers` before starting this version. Apply the Oblien API and consent dashboard release before enabling the two OpenShip environment variables.
4. Test with a disposable organization and VM. Confirm that the selected VM appears in Servers, the runtime probe succeeds, and new checks fail after the owner revokes the grant. Use Stripe test mode for a purchase rehearsal.

Connection attempts expire after an hour. An interrupted attachment can be retried through **Previously authorized VMs**. Removing a server follows the usual project-removal choices. To revoke the remaining provider authorization from OpenShip, delete it in Connections after detaching the server. The customer can revoke immediately in Oblien under **Settings → Connected applications**.
