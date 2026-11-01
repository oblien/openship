"use client";

import { useRef, useState } from "react";
import { Icon as UiIcon } from "@repo/ui/icons";
import {
  clusterDatabasePodCount,
  validateClusterDatabase,
  type ClusterDatabaseConfig,
} from "@repo/core";
import type { ClusterDatabase } from "@repo/contracts";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getApiErrorMessage } from "@/lib/api";
import { databaseInstanceStatus } from "./model";

/** Counts are a draft until the user reviews the exact saved database generation. */
export function ClusterDatabaseScaling({
  database,
  disabled,
  onApply,
  onRecovery,
}: {
  database: ClusterDatabase;
  disabled: boolean;
  onApply: (
    config: ClusterDatabaseConfig,
    expectedSequence: number,
    confirmRedisRebalance?: true,
  ) => Promise<ClusterDatabase | undefined>;
  onRecovery?: () => void;
}) {
  const { t } = useI18n();
  const text = t.projects.quickScale;
  const [baseline, setBaseline] = useState(database);
  const [instances, setInstances] = useState(String(database.config.instances));
  const [review, setReview] = useState<{ config: ClusterDatabaseConfig; sequence: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const postgres = database.config.engine === "postgres";
  const count = Number(instances);
  const changed = count !== baseline.config.instances;
  const sharded = database.config.engine === "redis" && database.config.mode === "cluster";
  const nextConfig: ClusterDatabaseConfig = {
    ...baseline.config,
    instances: count,
    ...(postgres ? { mode: count === 1 ? "standalone" : "cluster" } : {}),
  };
  const valid =
    !!instances.trim() &&
    Number.isInteger(count) &&
    count >= (sharded || database.config.mode === "replication" ? 3 : 1) &&
    count <= 9;
  const stale = !!review && database.sequence !== review.sequence;
  const readersBound = postgres && count === 1 && !!database.readEnvKey;
  const redisDownscale =
    database.config.engine === "redis" &&
    database.config.mode === "replication" &&
    count < database.config.instances;
  const observation = database.observation;
  const { ready, desired: configured } = databaseInstanceStatus(database);
  const request = async () => {
    if (!review || pending.current || disabled || stale || readersBound || redisDownscale) return;
    pending.current = true;
    setBusy(true);
    try {
      const row = await onApply(review.config, review.sequence, sharded ? true : undefined);
      if (row) {
        setBaseline(row);
        setInstances(String(row.config.instances));
        setReview(null);
      }
    } catch (reason) {
      setError(getApiErrorMessage(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="space-y-4">
      <div className="space-y-3 rounded-xl bg-muted/30 p-3">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">{text.readyInstances}</span>
          <span className="font-medium tabular-nums">
            {ready === undefined ? "—" : ready} / {configured}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {postgres
            ? interpolate(text.postgresLayout, { count: database.config.instances - 1 })
            : sharded
              ? interpolate(text.redisShards, { count: database.config.instances })
              : database.config.mode === "standalone"
                ? text.singleInstance
                : interpolate(text.redisLayout, { count: database.config.instances - 1 })}
        </p>
        {observation && (
          <p className="text-xs text-muted-foreground">
            {interpolate(text.observedAt, {
              time: new Date(observation.observedAt).toLocaleTimeString(),
            })}
          </p>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {postgres ? text.postgresHint : sharded ? text.redisShardHint : text.redisHint}
      </p>
      {database.config.mode === "replication" && (
        <p className="text-xs leading-relaxed text-muted-foreground">{text.sentinelHint}</p>
      )}
      <label className="block space-y-1.5 text-sm">
        <span>{postgres ? text.readReplicas : sharded ? text.shards : text.replicas}</span>
        <Input
          variant="filled"
          type="number"
          min={
            postgres
              ? 0
              : sharded
                ? 3
                : database.config.mode === "replication"
                  ? database.config.instances - 1
                  : 0
          }
          max={sharded ? 9 : 8}
          step={1}
          value={!instances.trim() ? "" : postgres || !sharded ? String(count - 1) : instances}
          disabled={
            disabled || busy || !!review || (!postgres && database.config.mode === "standalone")
          }
          onChange={(event) => {
            setInstances(
              event.target.value === ""
                ? ""
                : String(Number(event.target.value) + (sharded ? 0 : 1)),
            );
            setError(null);
          }}
        />
      </label>
      {postgres && count === 1 && database.config.instances > 1 && (
        <p className="text-xs leading-relaxed text-muted-foreground">{text.disconnectReaders}</p>
      )}
      {!postgres && database.config.mode === "standalone" && (
        <p
          role="status"
          className="rounded-xl bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground"
        >
          {text.redisStandalone}
        </p>
      )}
      {onRecovery &&
        ((!postgres && database.config.mode === "standalone") ||
          (sharded && !database.config.backup)) && (
          <Button
            className="w-full"
            variant="secondary"
            disabled={disabled || busy}
            onClick={onRecovery}
          >
            {text.openRecovery}
          </Button>
        )}
      {!valid && (
        <p role="alert" className="text-xs text-danger">
          {text.invalidCount}
        </p>
      )}
      {redisDownscale && (
        <p role="alert" className="text-xs text-warning">
          {text.redisDownscale}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {review ? (
        <div className="space-y-3 rounded-xl bg-muted/30 p-3" aria-label={text.reviewTitle}>
          <h3 className="text-sm font-medium">{text.reviewTitle}</h3>
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{text.instances}</dt>
              <dd className="font-medium tabular-nums">
                {clusterDatabasePodCount(baseline.config)} →{" "}
                {clusterDatabasePodCount(review.config)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{text.storageTotal}</dt>
              <dd className="font-medium tabular-nums">
                {clusterDatabasePodCount(review.config) * review.config.storageGiB} GiB
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{text.resourcesTotal}</dt>
              <dd className="font-medium tabular-nums">
                {(clusterDatabasePodCount(review.config) * review.config.cpuMillis) / 1000} vCPU ·{" "}
                {clusterDatabasePodCount(review.config) * review.config.memoryMiB} MiB
              </dd>
            </div>
          </dl>
          <p className="text-xs leading-relaxed text-muted-foreground">{text.capacityHint}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {sharded ? text.rebalanceReview : text.replicationReview}
          </p>
          {postgres && review.config.instances === 2 && (
            <p className="text-xs leading-relaxed text-warning">{text.singleReaderWarning}</p>
          )}
          {stale && (
            <p role="alert" className="text-xs text-warning">
              {text.staleReview}
            </p>
          )}
          <Button
            className="w-full"
            disabled={disabled || busy || stale || readersBound || redisDownscale}
            onClick={() => void request()}
          >
            {busy && <UiIcon name="spinner" className="size-4 animate-spin" />}
            {text.apply}
          </Button>
          <Button
            className="w-full"
            variant="ghost"
            disabled={busy || disabled}
            onClick={() => {
              setReview(null);
              if (stale) {
                setBaseline(database);
                setInstances(String(database.config.instances));
              }
            }}
          >
            {stale ? text.refreshDraft : text.edit}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Button
            className="w-full"
            disabled={
              disabled ||
              busy ||
              !valid ||
              !changed ||
              readersBound ||
              redisDownscale ||
              (sharded && !database.config.backup)
            }
            onClick={() => {
              try {
                validateClusterDatabase(nextConfig);
                setError(null);
                setReview({ config: nextConfig, sequence: baseline.sequence });
              } catch (reason) {
                setError(getApiErrorMessage(reason));
              }
            }}
          >
            {text.review}
          </Button>
          {!changed && <p className="text-xs text-muted-foreground">{text.unchanged}</p>}
          {sharded && !database.config.backup && (
            <p className="text-xs text-warning">{text.backupRequired}</p>
          )}
          {disabled && (
            <p role="status" className="text-xs text-muted-foreground">
              {text.operationPending}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
