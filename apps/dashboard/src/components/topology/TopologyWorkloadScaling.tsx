"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import type { WorkloadScaling } from "@repo/contracts";
import type { ProjectResources } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage } from "@/lib/api";
import { workloadScalingApi } from "@/lib/api/workload-scaling";
import type { Service } from "@/lib/api/services";
import type { TopologyProject } from "./model";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import {
  ReplicaCountInput,
  ReplicaScaleReview,
  validReplicaCount,
  type ReplicaReview,
} from "./ReplicaControls";

type Props = {
  project: TopologyProject;
  service?: Service;
  disabled: boolean;
  resources?: ProjectResources["production"];
};

export function TopologyWorkloadScaling(props: Props) {
  const scope = useResourceScope();
  return (
    <WorkloadScaling
      key={`${scope}:${props.project.id}:${props.service?.id ?? "app"}`}
      {...props}
    />
  );
}

function WorkloadScaling({ project, service, disabled, resources }: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const text = t.projects.quickScale;
  const [view, setView] = useState<WorkloadScaling | null>(null);
  const [instances, setInstances] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [review, setReview] = useState<ReplicaReview | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setReview(null);
    setError(null);
    void workloadScalingApi
      .get(project.id, service?.id)
      .then((next) => {
        if (!current) return;
        setView(next);
        setInstances(String(next.replicas));
        setError(next.error);
      })
      .catch((reason) => {
        if (current) {
          setView(null);
          setError(getApiErrorMessage(reason, "Scaling settings could not be loaded."));
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [project.id, project.activeDeploymentId, service?.id, revision]);
  const count = Number(instances);
  const blocked =
    disabled ||
    busy ||
    loading ||
    !view ||
    !!view.unavailableReason ||
    !!error ||
    !view.activeDeploymentId ||
    !validReplicaCount(instances);
  const changed = view && (count !== view.replicas || count !== view.activeReplicas);
  const stale =
    !!review &&
    (review.to !== count ||
      review.updatedAt !== view?.updatedAt ||
      review.deploymentId !== view?.activeDeploymentId);
  const apply = async () => {
    if (!view || !review || blocked || stale || pending.current) return;
    pending.current = true;
    setBusy(true);
    let navigating = false;
    try {
      const result = await workloadScalingApi.scale(project.id, {
        ...(service ? { serviceId: service.id } : {}),
        replicas: review.to,
        expectedDeploymentId: review.deploymentId,
        expectedUpdatedAt: review.updatedAt,
      });
      router.push(`/build/${result.deploymentId}`);
      navigating = true;
    } catch (reason) {
      setReview(null);
      setError(
        getApiErrorMessage(reason, "Instances could not be changed. Refresh before trying again."),
      );
    } finally {
      if (!navigating) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section className="space-y-3" aria-label="Application instances">
      <h3 className="text-sm font-medium">{text.instances}</h3>
      {loading && (
        <div
          role="status"
          className="h-10 animate-pulse rounded-xl bg-muted/40"
          aria-label="Loading scaling settings"
        />
      )}
      {view?.unavailableReason && (
        <p className="text-xs leading-relaxed text-muted-foreground">{view.unavailableReason}</p>
      )}
      {view && !view.unavailableReason && (
        <>
          {view.status && (
            <div className="rounded-xl bg-muted/40 p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span>Ready instances</span>
                <span className="font-medium tabular-nums">
                  {view.status.ready} / {view.status.desired}
                </span>
              </div>
              <ul className="mt-3 space-y-2">
                {view.status.pods.map((pod) => (
                  <li key={pod.name} className="flex items-center justify-between gap-2">
                    <span>{pod.name}</span>
                    <span className={pod.ready ? "text-muted-foreground" : "text-warning"}>
                      {pod.ready ? "Ready" : pod.phase}
                    </span>
                  </li>
                ))}
              </ul>
              {view.status.message && <p className="mt-2 text-warning">{view.status.message}</p>}
            </div>
          )}
          <ReplicaCountInput
            value={instances}
            onChange={setInstances}
            disabled={disabled || busy || loading}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {service
              ? "This count applies to this service."
              : "This count applies to the application."}{" "}
            All instances run on {project.serverName || "this server"}. Web traffic is balanced
            between them; workers process jobs independently.
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Docker applies the workload's restart policy. All instances share the server's capacity
            and availability.
          </p>
          <Button
            size="sm"
            disabled={blocked || !changed}
            onClick={() => {
              if (view.activeDeploymentId)
                setReview({
                  from: view.activeReplicas,
                  to: count,
                  deploymentId: view.activeDeploymentId,
                  updatedAt: view.updatedAt,
                });
            }}
          >
            {text.review}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {(error || view?.status) && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <Icon name="refresh" className="size-3.5" />
          Refresh
        </Button>
      )}
      {review && (
        <ReplicaScaleReview
          review={review}
          name={service?.name || project.name || "Application"}
          destination={project.serverName || "Current server"}
          notice="This deploys the current image with the new instance count. The workload may be briefly unavailable during replacement."
          resources={resources}
          busy={busy}
          disabled={blocked}
          stale={stale}
          onClose={() => setReview(null)}
          onApply={() => void apply()}
        />
      )}
    </section>
  );
}
