import type { KubernetesObject } from "./kubernetes-api";

/** Scheduling and image/init failures must be visible before a readiness timeout. */
export function kubernetesPodIssue(pod: KubernetesObject): string | null {
  const scheduling = pod.status?.conditions?.find(
    (condition: any) => condition.type === "PodScheduled" && condition.status === "False",
  );
  const statuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  const state = statuses
    .map(
      (container: any) =>
        container.state?.waiting ??
        (container.state?.terminated?.exitCode ? container.state.terminated : null),
    )
    .find(Boolean);
  const issue = scheduling ?? state;
  if (!issue) return null;
  return `${pod.metadata.name}: ${[issue.reason, issue.message].filter(Boolean).join(" · ")}`.slice(
    0,
    2000,
  );
}

export function kubernetesPodPhase(pod: KubernetesObject): string {
  const statuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  return (
    statuses.find((container: any) => container.state?.waiting)?.state.waiting.reason ??
    pod.status?.phase ??
    "Pending"
  );
}
