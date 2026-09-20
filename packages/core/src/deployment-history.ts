/** Status groups used by deployment history filters across transports. */
export const DEPLOYMENT_HISTORY_STATUSES = {
  success: ["ready", "no_changes"],
  failed: ["failed", "action_required", "partial_failure", "rejected"],
  building: ["building", "deploying", "reconciling"],
  pending: ["queued"],
  canceled: ["cancelled"],
} as const;

export type DeploymentHistoryFilter = keyof typeof DEPLOYMENT_HISTORY_STATUSES;
export interface DeploymentHistoryQuery {
  page?: number;
  perPage?: number;
  environment?: string;
  status?: DeploymentHistoryFilter;
  search?: string;
}
