"use client";

import { useEffect, useRef, useState } from "react";
import { Icon as UiIcon } from "@repo/ui/icons";
import type { ProjectAutoscalePolicy, AutoscaleEvent } from "@repo/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { projectAutoscaleApi } from "@/lib/api/project-autoscale";
import { getApiErrorMessage, getApiErrorCode } from "@/lib/api";
import { observedAllSettled } from "@repo/core/diagnostics";

type Props = {
  projectId: string;
  /** Present when the project runs (or is targeted) on a cluster. */
  clusterReady: boolean;
  disabled: boolean;
  onPolicyChanged?: (state: ProjectAutoscalePolicy | null) => void;
};

const DEFAULTS = {
  targetCpuPercent: 70,
  minReplicas: 1,
  maxReplicas: 6,
  stepSize: 1,
  cooldownSeconds: 120,
  suspendAfterFailures: 3,
};

/** Automatic scaling — the per-project autoscaler policy panel.
 *
 * This is the operator's half of the override handshake: the policy is the
 * only way autoscaling starts, a suspension banner is the only way it stops
 * after a human edit or a give-up, and the event trail is the "why did it
 * scale" record. Nothing here auto-applies without an explicit save. */
export function AutoscalePolicyPanel({
  projectId,
  clusterReady,
  disabled,
  onPolicyChanged,
}: Props) {
  const [policy, setPolicy] = useState<ProjectAutoscalePolicy | null>(null);
  const [absent, setAbsent] = useState(false);
  const [events, setEvents] = useState<AutoscaleEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState(DEFAULTS);
  const [enabled, setEnabled] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    if (!clusterReady || disabled) return;
    let current = true;
    setPolicy(null);
    setAbsent(false);
    setEnabled(false);
    setForm(DEFAULTS);
    setEvents([]);
    setLoaded(false);
    setError(null);
    void observedAllSettled(
      [projectAutoscaleApi.get(projectId), projectAutoscaleApi.events(projectId)],
      "dashboard/lib/project-autoscale/AutoscalePolicyPanel",
    ).then((results) => {
      if (!current) return;
      if (results[0].status === "fulfilled") {
        const row = results[0].value;
        setPolicy(row);
        setAbsent(false);
        setEnabled(row.enabled);
        setForm({
          targetCpuPercent: row.targetCpuPercent,
          minReplicas: row.minReplicas,
          maxReplicas: row.maxReplicas,
          stepSize: row.stepSize,
          cooldownSeconds: row.cooldownSeconds,
          suspendAfterFailures: row.suspendAfterFailures,
        });
        onPolicyChanged?.(row);
      } else {
        setPolicy(null);
        const absent = getApiErrorCode(results[0].reason) === "AUTOSCALE_POLICY_ABSENT";
        setAbsent(absent);
        setEnabled(false);
        setForm(DEFAULTS);
        if (!absent)
          setError(
            getApiErrorMessage(results[0].reason, "Autoscaling settings could not be loaded."),
          );
        onPolicyChanged?.(null);
      }
      if (results[1].status === "fulfilled") setEvents(results[1].value.events);
      else setEvents([]);
      setLoaded(true);
    });
    return () => {
      current = false;
    };
  }, [projectId, revision, onPolicyChanged, clusterReady, disabled]);

  if (!clusterReady || disabled) return null;
  if (!loaded) return null;
  if (!policy && !absent)
    return (
      <div className="space-y-2 text-xs">
        <p role="alert" className="text-danger">
          {error}
        </p>
        <Button size="sm" variant="secondary" onClick={() => setRevision((value) => value + 1)}>
          Retry loading autoscaling
        </Button>
      </div>
    );

  const suspended = !!policy?.suspendedAt;
  const unsaved =
    !policy ||
    enabled !== policy.enabled ||
    form.targetCpuPercent !== policy.targetCpuPercent ||
    form.minReplicas !== policy.minReplicas ||
    form.maxReplicas !== policy.maxReplicas ||
    form.stepSize !== policy.stepSize ||
    form.cooldownSeconds !== policy.cooldownSeconds ||
    form.suspendAfterFailures !== policy.suspendAfterFailures;
  const boundsOk = form.minReplicas >= 1 && form.maxReplicas >= form.minReplicas;
  const rearm = suspended && enabled;

  const save = async () => {
    if (pending.current || !boundsOk) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const row = await projectAutoscaleApi.set(projectId, {
        ...form,
        enabled,
        ...(suspended && rearm ? { rearm: true as const } : {}),
        expectedUpdatedAt: policy?.updatedAt ?? null,
      });
      setPolicy(row);
      setEnabled(row.enabled);
      setAbsent(false);
      onPolicyChanged?.(row);
    } catch (reason) {
      setError(getApiErrorMessage(reason, "The autoscaling policy could not be saved."));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <UiIcon name="gauge" className="size-4 text-info" /> Automatic scaling
      </h3>
      <label className="flex items-start gap-2 text-xs leading-relaxed">
        <Checkbox
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={busy}
          aria-label="Enable autoscaling"
        />
        <span>
          The autoscaler watches CPU usage and adds or removes instances one step at a time, between
          the limits below.{" "}
          {policy?.enabled && !suspended
            ? "Automatic scaling is enabled."
            : "It stays idle until you save it enabled."}
        </span>
      </label>
      {suspended && (
        <div
          role="status"
          className="space-y-1 rounded-xl bg-muted/40 p-3 text-xs leading-relaxed text-warning"
        >
          <p className="flex items-center gap-1.5 font-medium">
            <UiIcon name="alert-circle" className="size-3.5" /> Autoscaling is suspended
          </p>
          <p>
            {policy?.suspendedReason ?? "A change moved the instance count outside the autoscaler."}
          </p>
          <p>
            If instances were changed outside Openship, apply that count in manual scaling first.
            Then review the settings and select Resume autoscaling.
          </p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
        <label className="block space-y-1.5">
          <span>Target CPU (%)</span>
          <input
            className="topology-input"
            type="number"
            min={1}
            max={100}
            value={form.targetCpuPercent}
            disabled={busy}
            onChange={(event) =>
              setForm({
                ...form,
                targetCpuPercent: clampInt(event.target.value, 1, 100, form.targetCpuPercent),
              })
            }
          />
        </label>
        <label className="block space-y-1.5">
          <span>Cooldown (seconds)</span>
          <input
            className="topology-input"
            type="number"
            min={30}
            max={3600}
            step={30}
            value={form.cooldownSeconds}
            disabled={busy}
            onChange={(event) =>
              setForm({
                ...form,
                cooldownSeconds: clampInt(event.target.value, 30, 3600, form.cooldownSeconds),
              })
            }
          />
        </label>
        <label className="block space-y-1.5">
          <span>Min instances</span>
          <input
            className="topology-input"
            type="number"
            min={1}
            max={100}
            value={form.minReplicas}
            disabled={busy}
            onChange={(event) =>
              setForm({
                ...form,
                minReplicas: clampInt(event.target.value, 1, 100, form.minReplicas),
              })
            }
          />
        </label>
        <label className="block space-y-1.5">
          <span>Max instances</span>
          <input
            className="topology-input"
            type="number"
            min={1}
            max={100}
            value={form.maxReplicas}
            disabled={busy}
            onChange={(event) =>
              setForm({
                ...form,
                maxReplicas: clampInt(event.target.value, 1, 100, form.maxReplicas),
              })
            }
          />
        </label>
        <label className="block space-y-1.5">
          <span>Step size</span>
          <input
            className="topology-input"
            type="number"
            min={1}
            max={10}
            value={form.stepSize}
            disabled={busy}
            onChange={(event) =>
              setForm({ ...form, stepSize: clampInt(event.target.value, 1, 10, form.stepSize) })
            }
          />
        </label>
        <label className="block space-y-1.5">
          <span>Suspend after failures</span>
          <input
            className="topology-input"
            type="number"
            min={1}
            max={10}
            value={form.suspendAfterFailures}
            disabled={busy}
            onChange={(event) =>
              setForm({
                ...form,
                suspendAfterFailures: clampInt(
                  event.target.value,
                  1,
                  10,
                  form.suspendAfterFailures,
                ),
              })
            }
          />
        </label>
      </div>
      {!boundsOk && (
        <p role="alert" className="text-xs text-danger">
          Max instances must be at least min instances.
        </p>
      )}
      {(unsaved || suspended) && (
        <Button
          className="w-full"
          size="sm"
          disabled={busy || !boundsOk}
          onClick={() => void save()}
        >
          {busy && <UiIcon name="spinner" className="size-4 animate-spin" />}
          {suspended && rearm ? "Resume autoscaling" : "Save policy"}
        </Button>
      )}
      {events.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Recent decisions ({events.length})
          </summary>
          <ul className="mt-3 space-y-2 text-muted-foreground">
            {events.slice(0, 10).map((event) => (
              <li key={event.id} className="leading-relaxed">
                <span className="text-foreground">
                  {new Date(event.createdAt).toLocaleString()}
                </span>{" "}
                · {EVENT_LABEL[event.action] ?? event.action}
                {event.toReplicas !== null
                  ? ` · ${event.fromReplicas} → ${event.toReplicas} instances`
                  : event.observedCpuPercent !== null
                    ? ` · ${Math.round(event.observedCpuPercent)}% CPU`
                    : ""}{" "}
                — {event.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

const EVENT_LABEL: Record<AutoscaleEvent["action"], string> = {
  scale_up: "Scaled up",
  scale_down: "Scaled down",
  hold: "Held",
  fail: "Failed",
  suspend: "Suspended",
};

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
