export function serviceEnvApplyTrigger({
  projectId,
  serviceId,
}: {
  projectId: string;
  serviceId: string;
}): {
  projectId: string;
  refresh: true;
  serviceIds: string[];
} {
  return { projectId, refresh: true, serviceIds: [serviceId] };
}
