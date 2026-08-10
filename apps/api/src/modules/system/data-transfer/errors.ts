/**
 * Defense-in-depth gate for whole-instance data transfer.
 *
 * The multi-tenant SaaS (CLOUD_MODE) must NEVER be an export source or an import
 * (wipe) target — an instance-scope wipe TRUNCATEs every tenant's rows. Today the
 * only protection is that `/api/system` routes are unmounted in CLOUD_MODE
 * (app.ts). This error backs an in-function refusal so a stray in-process call or
 * a route-mount regression can't open the hole.
 */
export class CloudInstanceNotTransferableError extends Error {
  readonly code = "CLOUD_INSTANCE_NOT_TRANSFERABLE" as const;
  constructor() {
    super("Whole-instance export/import is disabled on a multi-tenant (cloud) instance.");
    this.name = "CloudInstanceNotTransferableError";
  }
}
