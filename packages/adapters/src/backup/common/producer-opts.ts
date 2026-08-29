/**
 * The one place a policy's free-form `payloadConfig` becomes typed producer options.
 *
 * `payloadConfig` is jsonb. It is forwarded WHOLE — hand-picking keys here is what
 * once dropped every `custom_command` key and made each mail backup unrestorable — so
 * this deliberately does not filter, validate, or reshape it. It REPAIRS exactly the
 * fields whose declared type the producers then trust without re-checking, and leaves
 * everything else untouched.
 *
 * Today that is one field, and the reason it needs repairing is worth stating: a
 * `compression` value outside the codec vocabulary used to reach the shell layer as if
 * it were a codec. The compressor lookup fell through to "apply nothing", so the
 * artifact was written uncompressed while its metadata recorded the bogus name; the
 * restore read that name back through `recordedCodec`, which maps anything
 * unrecognised to `zstd`, and piped a plain tar through `zstd -d`. Capture green,
 * bytes real, restore impossible — and only discoverable by trying it.
 *
 * `validatePolicyPayload` now refuses such a value at save time, so new policies
 * cannot carry one. This covers the ones already stored, and anything written straight
 * to the column.
 *
 * Repaired by DELETION rather than by substituting a default: absent has always meant
 * "probe the container, or use the producer's own default", which is the reading that
 * cannot produce an artifact nobody can open. A garbage value becomes indistinguishable
 * from an unset one, which is what it always should have been.
 */

import { isPayloadCompression } from "@repo/core";

import type { ProducerOpts } from "../types";

export function sanitizeProducerOpts(
  config: Record<string, unknown> | null | undefined,
): ProducerOpts {
  const opts: Record<string, unknown> = { ...(config ?? {}) };
  // Keyed on PRESENCE, not on `!== undefined`, so the invariant is exact: after this
  // returns, `compression` is present if and only if it holds a codec the pipeline can
  // build. An explicit `{ compression: undefined }` — which jsonb can hold, and which a
  // caller spreading a partial object produces — would otherwise survive as a carried
  // key, and a carried key is a third state (`null` once it round-trips through
  // metadata) that the restore side has no reading for.
  if ("compression" in opts && !isPayloadCompression(opts.compression)) {
    delete opts.compression;
  }
  return opts as ProducerOpts;
}
