# Start a service with empty storage

In a deployed service, open **Volumes**, then the volume’s menu → **Start with empty storage**.
Confirm the service name to save a fresh named volume and redeploy only this service.

This action keeps the previous volume and backups. It never formats, erases, or removes an existing
volume. Services sharing the old volume continue using it. Bind mounts and read-only mounts do not
offer this action.

Saving the volume setting and admitting a deployment are separate operations. If admission fails,
the dialog explains that the setting was saved and offers **Retry deployment**, using the same
volume name. The deployment page reports whether the new service actually starts; admission alone
is not successful activation. Normal deployment readiness and rollback behavior still apply.

To recover the previous data, edit the mount’s source back to the previous name shown in the
confirmation and redeploy. Historical deployment configuration also retains the previous mount.
A normal restart does not change a container’s mounts.
