import { isMutableImageRef, type BaseImageReceipt, type RuntimeImageReceipts } from "@repo/core";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const reference = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096;
/** Immutable replay refs must not erase the mutable tag recorded by the original release. */
export function runtimeImageTrackingRef(
  requestedRef: string,
  frozenRef: unknown,
  replay = false,
): string {
  return replay && !isMutableImageRef(requestedRef) && reference(frozenRef)
    ? frozenRef
    : requestedRef;
}
export function readBaseImageReceipts(value: unknown): BaseImageReceipt[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is BaseImageReceipt =>
          object(item) &&
          reference(item.ref) &&
          typeof item.digest === "string" &&
          /^sha256:[a-f0-9]{64}$/.test(item.digest),
      )
    : [];
}

/** Keep observed build metadata separate from deployment instructions and untrusted JSON. */
export function readRuntimeImageReceipts(value: unknown): RuntimeImageReceipts {
  if (!object(value)) return {};
  const artifacts = object(value.artifacts) ? value.artifacts : {};
  return {
    app: readBaseImageReceipts(value.app),
    services: object(value.services)
      ? Object.fromEntries(
          Object.entries(value.services).map(([id, bases]) => [id, readBaseImageReceipts(bases)]),
        )
      : {},
    artifacts: {
      ...(reference(artifacts.app) ? { app: artifacts.app } : {}),
      services: object(artifacts.services)
        ? Object.fromEntries(
            Object.entries(artifacts.services).filter((entry): entry is [string, string] =>
              reference(entry[1]),
            ),
          )
        : {},
    },
  };
}

export function recordRuntimeImageReceipts(
  previous: unknown,
  updates: Array<{
    serviceId?: string;
    imageRef: string;
    baseImages?: BaseImageReceipt[];
  }>,
): RuntimeImageReceipts {
  const result = readRuntimeImageReceipts(previous);
  for (const update of updates) {
    if (update.serviceId) {
      (result.services ??= {})[update.serviceId] = readBaseImageReceipts(update.baseImages);
      ((result.artifacts ??= {}).services ??= {})[update.serviceId] = update.imageRef;
    } else {
      result.app = readBaseImageReceipts(update.baseImages);
      (result.artifacts ??= {}).app = update.imageRef;
    }
  }
  return result;
}
