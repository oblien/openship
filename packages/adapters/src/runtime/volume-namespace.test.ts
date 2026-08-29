import { describe, it, expect } from "vitest";
import {
  scopedVolumeName,
  ensureScopedVolumeName,
  isHostPathSource,
  scopeVolumeBinds,
} from "./volume-namespace";

describe("scopedVolumeName", () => {
  it("prefixes with openship-<slug>-", () => {
    expect(scopedVolumeName("clincai", "postgres_data")).toBe(
      "openship-clincai-postgres_data",
    );
  });
});

describe("ensureScopedVolumeName", () => {
  it("scopes a bare name", () => {
    expect(ensureScopedVolumeName("clincai", "postgres_data")).toBe(
      "openship-clincai-postgres_data",
    );
  });

  it("leaves an already-scoped name alone", () => {
    // The backup executor's DB fallback double-prefixed here, naming a volume that
    // has never existed — docker creates it empty on mount, so the capture archived
    // nothing and a restore wrote where nothing reads.
    expect(ensureScopedVolumeName("clincai", "openship-clincai-postgres_data")).toBe(
      "openship-clincai-postgres_data",
    );
  });

  it("still scopes a name that carries ANOTHER project's prefix", () => {
    // Not idempotence — that string is a foreign volume as far as this project is
    // concerned, and silently adopting it would cross a data boundary.
    expect(ensureScopedVolumeName("clincai", "openship-other-pgdata")).toBe(
      "openship-clincai-openship-other-pgdata",
    );
  });

  it("agrees with scopeVolumeBinds on the same source", () => {
    // The two guards were written independently and diverged; a source and its spec
    // must resolve to the same volume or backup and deploy mount different things.
    const spec = scopeVolumeBinds("clincai", ["openship-clincai-pgdata:/data"], true)[0]!;
    expect(spec.split(":")[0]).toBe(ensureScopedVolumeName("clincai", "openship-clincai-pgdata"));
  });
});

describe("isHostPathSource", () => {
  it("flags host paths", () => {
    expect(isHostPathSource("/var/data")).toBe(true);
    expect(isHostPathSource("./data")).toBe(true);
    expect(isHostPathSource("../data")).toBe(true);
    expect(isHostPathSource("~/data")).toBe(true); // the gap the legacy classifier missed
  });
  it("does not flag named volumes", () => {
    expect(isHostPathSource("postgres_data")).toBe(false);
    expect(isHostPathSource("pgdata")).toBe(false);
  });
});

describe("scopeVolumeBinds", () => {
  const slug = "clincai";

  it("scopes a named volume", () => {
    expect(scopeVolumeBinds(slug, ["postgres_data:/var/lib/postgresql/data"], true)).toEqual([
      "openship-clincai-postgres_data:/var/lib/postgresql/data",
    ]);
  });

  it("preserves a trailing mode suffix", () => {
    expect(scopeVolumeBinds(slug, ["pgdata:/data:ro"], true)).toEqual([
      "openship-clincai-pgdata:/data:ro",
    ]);
  });

  it("passes bind mounts through untouched (/, ./, ../, ~)", () => {
    const binds = ["/host/data:/data", "./rel:/data", "../up:/data", "~/home:/data"];
    expect(scopeVolumeBinds(slug, binds, true)).toEqual(binds);
  });

  it("passes anonymous (single-segment) volumes through untouched", () => {
    expect(scopeVolumeBinds(slug, ["/var/lib/postgresql/data"], true)).toEqual([
      "/var/lib/postgresql/data",
    ]);
  });

  it("is a no-op when disabled (grandfathered services keep bare names)", () => {
    const binds = ["postgres_data:/var/lib/postgresql/data"];
    expect(scopeVolumeBinds(slug, binds, false)).toEqual(binds);
  });

  it("is idempotent — does not double-scope an already-scoped source", () => {
    const once = scopeVolumeBinds(slug, ["postgres_data:/data"], true);
    expect(scopeVolumeBinds(slug, once, true)).toEqual(once);
  });

  it("scopes each named volume in a mixed list independently", () => {
    expect(
      scopeVolumeBinds(
        slug,
        ["pgdata:/var/lib/postgresql/data", "/etc/config:/config:ro", "redis_data:/data"],
        true,
      ),
    ).toEqual([
      "openship-clincai-pgdata:/var/lib/postgresql/data",
      "/etc/config:/config:ro",
      "openship-clincai-redis_data:/data",
    ]);
  });
});
