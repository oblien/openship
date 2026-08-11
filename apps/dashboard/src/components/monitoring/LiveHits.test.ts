import { describe, it, expect } from "vitest";
import { countryCentre, pacingFor } from "./LiveHits";
import countryPaths from "./country-paths.json";

const PATHS = (countryPaths as { paths: Record<string, string> }).paths;

/**
 * The map is equirectangular over a 360x180 viewBox, so a centre converts back to
 * lon/lat by simple arithmetic. Asserting in DEGREES rather than user units is the
 * point: "x is 84.17" says nothing about whether the ripple lands on the right
 * continent, and landing on the wrong continent is the only failure that matters here.
 */
function toLonLat(p: { x: number; y: number }) {
  return { lon: p.x - 180, lat: 90 - p.y };
}

describe("where a country's ripple lands", () => {
  it.each([
    ["US", -98, 39, 12], // continental USA
    ["BR", -53, -11, 10],
    ["IN", 79, 22, 10],
    ["AU", 134, -25, 10],
    ["DE", 10, 51, 6],
    ["JP", 138, 37, 10],
    ["ZA", 25, -29, 8],
    ["GB", -2, 54, 6],
  ])("%s lands near %i°,%i°", (code, lon, lat, tolerance) => {
    const centre = countryCentre(code);
    expect(centre).not.toBeNull();
    const got = toLonLat(centre!);
    expect(Math.abs(got.lon - lon)).toBeLessThan(tolerance);
    expect(Math.abs(got.lat - lat)).toBeLessThan(tolerance);
  });

  it("uses the largest landmass, not the whole bounding box", () => {
    // The box around the mainland USA plus Alaska centres in the Pacific, near 150°W.
    // Picking the biggest polygon is what keeps the ripple on the country.
    const us = toLonLat(countryCentre("US")!);
    expect(us.lon).toBeGreaterThan(-125);
    // Same failure for France, whose bounding box includes French Guiana (~53°W).
    const fr = toLonLat(countryCentre("FR")!);
    expect(fr.lon).toBeGreaterThan(-10);
    expect(fr.lat).toBeGreaterThan(40);
  });

  it("returns null for a code the atlas cannot draw, rather than 0,0", () => {
    // 0,0 is in the Gulf of Guinea — a plausible-looking position for a country we have
    // no shape for would be worse than drawing nothing.
    expect(countryCentre("XX")).toBeNull();
    expect(countryCentre("")).toBeNull();
  });

  it("resolves a centre inside the viewBox for every country in the atlas", () => {
    const outside: string[] = [];
    for (const code of Object.keys(PATHS)) {
      const c = countryCentre(code);
      if (!c || c.x < 0 || c.x > 360 || c.y < 0 || c.y > 180) outside.push(code);
    }
    expect(outside).toEqual([]);
  });

  it("memoises, so a busy stream doesn't re-parse a path per hit", () => {
    // At a few hundred hits a minute this runs constantly; the parse is a regex over a
    // multi-kilobyte string.
    const a = countryCentre("US");
    const b = countryCentre("US");
    expect(a).toBe(b); // identity, not equality
  });
});

describe("presentation pace tracks the arrival rate", () => {
  it("lingers when traffic is quiet", () => {
    // A site doing a couple of requests a minute needs each ripple to stay long enough to
    // be noticed at all.
    const quiet = pacingFor(0);
    expect(quiet.rippleMs).toBe(1600);
    expect(quiet.cooldownMs).toBe(450);
    // Anything at or below the quiet threshold gets the same treatment.
    expect(pacingFor(2)).toEqual(quiet);
    expect(pacingFor(-5)).toEqual(quiet);
  });

  it("fires and clears fast when traffic is heavy", () => {
    // At high rate a long ripple plus a long cooldown throttles the DISPLAY below the real
    // traffic — the map would understate a spike, which is the opposite of the point.
    const busy = pacingFor(25);
    expect(busy.rippleMs).toBe(650);
    expect(busy.cooldownMs).toBe(45);
    // Clamped: a 500/sec burst is not faster than the floor.
    expect(pacingFor(500)).toEqual(busy);
  });

  it("moves monotonically between the two, never inverted", () => {
    // Inverting this curve is the easy mistake and impossible to spot by eye, because both
    // ends still animate — it would just feel wrong under load.
    const rates = [0, 1, 2, 5, 10, 15, 20, 25, 60];
    const ripples = rates.map((r) => pacingFor(r).rippleMs);
    const cooldowns = rates.map((r) => pacingFor(r).cooldownMs);
    for (let i = 1; i < rates.length; i++) {
      expect(ripples[i]).toBeLessThanOrEqual(ripples[i - 1]);
      expect(cooldowns[i]).toBeLessThanOrEqual(cooldowns[i - 1]);
    }
    // And the middle is genuinely interpolated, not snapped to an end.
    const mid = pacingFor(13.5);
    expect(mid.rippleMs).toBeGreaterThan(650);
    expect(mid.rippleMs).toBeLessThan(1600);
  });

  it("keeps the animation and the JS expiry on the same number", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("./monitoring.css", import.meta.url), "utf8");
    // The duration is passed to CSS as a variable rather than hardcoded in both places. A
    // shorter animation would leave a dead circle on the map; a longer one would be cut off.
    expect((css.match(/var\(--geo-ripple-ms/g) ?? []).length).toBe(3);
    expect(css).not.toMatch(/animation: geo-ripple-out 1\.6s/);
    const src = readFileSync(new URL("./LiveHits.tsx", import.meta.url), "utf8");
    expect(src).toContain('"--geo-ripple-ms"');
  });
});
