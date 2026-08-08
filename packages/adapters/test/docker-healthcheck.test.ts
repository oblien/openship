import { describe, expect, it } from "vitest";

import { toDockerHealthcheck } from "../src/runtime/docker";

/**
 * `toDockerHealthcheck` is the runtime's last chance to turn a compose or
 * catalog healthcheck into the shape the Docker Engine expects. The parsed
 * compose form normalizes `test` to a string or an argv array, but app-catalog
 * JSON and compose migrations can leave the original Docker `CMD` / `CMD-SHELL`
 * prefix in place. That must not produce an extra leading `CMD` in the final
 * `Test` array, or Docker treats it as an unknown healthcheck command and marks
 * the container unhealthy.
 */
describe("toDockerHealthcheck", () => {
  it("turns a shell test string into CMD-SHELL", () => {
    const hc = toDockerHealthcheck({ test: "pg_isready -U postgres" });
    expect(hc).toMatchObject({ Test: ["CMD-SHELL", "pg_isready -U postgres"] });
  });

  it("wraps a plain argv array with CMD", () => {
    const hc = toDockerHealthcheck({ test: ["pg_isready", "-U", "postgres"] });
    expect(hc).toMatchObject({ Test: ["CMD", "pg_isready", "-U", "postgres"] });
  });

  it("does not duplicate a CMD prefix already present in the test array", () => {
    const hc = toDockerHealthcheck({
      test: ["CMD", "pg_isready", "-U", "postgres"],
    });
    expect(hc).toMatchObject({ Test: ["CMD", "pg_isready", "-U", "postgres"] });
  });

  it("does not duplicate a CMD-SHELL prefix already present in the test array", () => {
    const hc = toDockerHealthcheck({
      test: ["CMD-SHELL", "curl -f http://localhost/health || exit 1"],
    });
    expect(hc).toMatchObject({
      Test: ["CMD-SHELL", "curl -f http://localhost/health || exit 1"],
    });
  });

  it("returns NONE for a disabled healthcheck", () => {
    const hc = toDockerHealthcheck({ disable: true });
    expect(hc).toMatchObject({ Test: ["NONE"] });
  });

  it("carries duration fields through unchanged", () => {
    const hc = toDockerHealthcheck({
      test: ["CMD", "pg_isready"],
      interval: "5s",
      timeout: "3s",
      startPeriod: "10s",
      retries: 3,
    });
    expect(hc).toMatchObject({
      Test: ["CMD", "pg_isready"],
      Interval: 5_000_000_000,
      Timeout: 3_000_000_000,
      StartPeriod: 10_000_000_000,
      Retries: 3,
    });
  });

  it("returns undefined when there is no usable test", () => {
    expect(toDockerHealthcheck({})).toBeUndefined();
    expect(toDockerHealthcheck({ test: "" })).toBeUndefined();
    expect(toDockerHealthcheck({ test: [] })).toBeUndefined();
  });
});
