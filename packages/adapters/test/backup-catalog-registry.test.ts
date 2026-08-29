/**
 * The catalog and the producer registry must describe the same set of kinds, in the
 * same order.
 *
 * Two halves of one contract, and neither is checkable by the compiler:
 *
 *   - **Coverage.** The catalog is a `Record<PayloadKind, …>`, so a kind cannot exist
 *     without a spec. Nothing makes it exist with a PRODUCER. A kind in the catalog
 *     with no registered producer is a value the dashboard offers, the policy service
 *     accepts, and the orchestrator then throws on at 3am on the first scheduled run.
 *
 *   - **Order.** The registry walks producers in REGISTRATION order and takes the first
 *     whose `detects()` matches, and registration order is decided by import order in
 *     `src/backup/index.ts` — a fact that lived only in a comment. If the volume
 *     fallback were imported before the DB producers, it would answer for every service
 *     and every database would silently get a crash-consistent tar of its live data
 *     directory instead of a logical dump. That is #611 with a different cause, and
 *     nothing would have failed to compile.
 *
 * `PAYLOAD_KINDS` is that order written down where it can be asserted, so the array and
 * the imports cannot drift apart.
 */

import { describe, expect, it } from "vitest";
import { BACKUP_PAYLOADS, PAYLOAD_KINDS, payloadSpec } from "@repo/core";
import "../src/backup"; // side-effect: registers every producer, in order
import { listRegisteredProducers, resolveProducer } from "../src/backup/registry";

describe("every catalog kind has a producer, and vice versa", () => {
  it("registers exactly the kinds the catalog declares", () => {
    expect([...listRegisteredProducers()].sort()).toEqual([...PAYLOAD_KINDS].sort());
  });

  it("resolves every catalog kind to a producer that agrees about its own kind", () => {
    for (const kind of PAYLOAD_KINDS) {
      const producer = resolveProducer(kind);
      expect(producer, kind).toBeDefined();
      // A producer filed under one kind but reporting another would record artifacts
      // that no restore path can match back to it.
      expect(producer.kind, kind).toBe(kind);
    }
  });

  it("gives every producer both directions", () => {
    for (const kind of PAYLOAD_KINDS) {
      const producer = resolveProducer(kind);
      expect(typeof producer.produce, kind).toBe("function");
      // A capture with no restore is not a backup. The catalog can say a kind needs a
      // recorded command to be restorable; it cannot say a kind has no restore at all.
      expect(typeof producer.restore, kind).toBe("function");
    }
  });
});

describe("registration order matches the catalog's declared priority", () => {
  it("registers in exactly PAYLOAD_KINDS order", () => {
    expect(listRegisteredProducers()).toEqual([...PAYLOAD_KINDS]);
  });

  it("puts the universal fallback last", () => {
    // `volume` matches nothing and is chosen by `resolveProducerForService` when nothing
    // detects. Registered anywhere but last it would shadow whatever follows it.
    const order = listRegisteredProducers();
    expect(order[order.length - 1]).toBe("volume");
  });

  it("puts every image-detectable kind ahead of the fallback", () => {
    const order = listRegisteredProducers();
    const fallbackAt = order.indexOf("volume");
    for (const kind of PAYLOAD_KINDS) {
      if (!payloadSpec(kind).images) continue;
      expect(order.indexOf(kind), kind).toBeLessThan(fallbackAt);
    }
  });

  it("gives a detects() to exactly the image-detectable kinds", () => {
    // The catalog's `images` field and the producer's `detects()` are two statements of
    // the same decision. A producer with a `detects()` but no catalog entry auto-selects
    // on a rule the dialog cannot show the operator — which is the exact asymmetry #611
    // was made of.
    for (const kind of PAYLOAD_KINDS) {
      const hasDetect = typeof resolveProducer(kind).detects === "function";
      expect(hasDetect, kind).toBe(!!BACKUP_PAYLOADS[kind].images);
    }
  });
});
