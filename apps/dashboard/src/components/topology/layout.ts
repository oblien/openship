export type TopologyPositions = Record<string, { x: number; y: number }>;

/** Layout is a local preference. Never store service config, env, or fake resources. */
export function readTopologyPositions(key: string): TopologyPositions {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 256_000) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const positions: TopologyPositions = {};
    for (const [id, value] of Object.entries(parsed).slice(0, 1000)) {
      if (!value || typeof value !== "object") continue;
      const { x, y } = value as Record<string, unknown>;
      if (
        typeof x === "number" &&
        typeof y === "number" &&
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Math.abs(x) < 100_000 &&
        Math.abs(y) < 100_000
      )
        positions[id] = { x, y };
    }
    return positions;
  } catch {
    return {};
  }
}

export function saveTopologyPositions(key: string, positions: TopologyPositions): void {
  try {
    localStorage.setItem(key, JSON.stringify(positions));
  } catch {
    /* Canvas remains usable without local storage. */
  }
}
