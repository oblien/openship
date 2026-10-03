/**
 * Three registries — one per adapter axis (executor, producer,
 * destination). Adapters self-register at module load via the
 * `register*` helpers; the orchestrator never imports concrete
 * implementations, only `resolve*` accessors.
 *
 * The trigger axis has no registry because triggers aren't pluggable
 * adapters — they're values that funnel into orchestrator.runBackup().
 */

import type {
  BackupDestinationRow,
  BackupExecutor,
  BackupProducer,
  BackupDestination,
  DestinationFactory,
  DestinationKind,
  ExecutorFactory,
  PayloadKind,
  ServiceHandle,
} from "./types";

// ─── Executors ───────────────────────────────────────────────────────────────

const executorFactories = new Map<string, ExecutorFactory>();

export function registerExecutor(
  runtimeName: BackupExecutor["runtimeName"],
  factory: ExecutorFactory,
): void {
  if (executorFactories.has(runtimeName)) {
    // Allow re-registration in dev (HMR / re-imports). Last write wins.
    executorFactories.set(runtimeName, factory);
    return;
  }
  executorFactories.set(runtimeName, factory);
}

export function resolveExecutor(runtimeName: string, runtime: unknown): BackupExecutor {
  const factory = executorFactories.get(runtimeName);
  if (!factory) {
    throw new Error(
      `No backup executor registered for runtime "${runtimeName}". ` +
        `Registered: ${[...executorFactories.keys()].join(", ") || "(none)"}`,
    );
  }
  return factory(runtime);
}

export function listRegisteredExecutors(): string[] {
  return [...executorFactories.keys()];
}

// ─── Producers ───────────────────────────────────────────────────────────────

/**
 * Producers are kept in BOTH a map (resolve-by-kind) and an array
 * (ordered detect-by-service). Registration order = detect priority,
 * so DB-specific producers (pg_dump, etc.) must register before the
 * generic VolumeCopyProducer.
 */
const producersByKind = new Map<PayloadKind, BackupProducer>();
const producerOrder: BackupProducer[] = [];

export function registerProducer(producer: BackupProducer): void {
  if (producersByKind.has(producer.kind)) {
    // Replace + update order in place.
    const idx = producerOrder.findIndex((p) => p.kind === producer.kind);
    if (idx >= 0) producerOrder[idx] = producer;
    producersByKind.set(producer.kind, producer);
    return;
  }
  producersByKind.set(producer.kind, producer);
  producerOrder.push(producer);
}

export function resolveProducer(kind: PayloadKind): BackupProducer {
  const producer = producersByKind.get(kind);
  if (!producer) {
    throw new Error(
      `No backup producer registered for kind "${kind}". ` +
        `Registered: ${[...producersByKind.keys()].join(", ") || "(none)"}`,
    );
  }
  return producer;
}

/**
 * Pick a producer by walking detect() in registration order. Used when
 * `backup_policy.payload_kind` is the literal string "auto". Returns
 * the first producer whose detect() returns true; falls back to the
 * volume producer.
 */
export function resolveProducerForService(service: ServiceHandle): BackupProducer {
  for (const producer of producerOrder) {
    if (producer.detects?.(service)) return producer;
  }
  // Volume is the universal fallback. If it isn't registered yet,
  // surface that clearly — it should always register first.
  const volume = producersByKind.get("volume");
  if (!volume) {
    throw new Error(
      "No backup producer matched service AND the volume fallback is not registered.",
    );
  }
  return volume;
}

export function listRegisteredProducers(): PayloadKind[] {
  return producerOrder.map((p) => p.kind);
}

// ─── Destinations ────────────────────────────────────────────────────────────

const destinationFactories = new Map<DestinationKind, DestinationFactory>();

export function registerDestination(
  kind: DestinationKind,
  factory: DestinationFactory,
): void {
  destinationFactories.set(kind, factory);
}

export function resolveDestination(row: BackupDestinationRow): BackupDestination {
  const factory = destinationFactories.get(row.kind);
  if (!factory) {
    throw new Error(
      `No backup destination registered for kind "${row.kind}". ` +
        `Registered: ${[...destinationFactories.keys()].join(", ") || "(none)"}`,
    );
  }
  return factory(row);
}

export function listRegisteredDestinations(): DestinationKind[] {
  return [...destinationFactories.keys()];
}
