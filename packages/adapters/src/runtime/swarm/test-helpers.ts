import type { CommandExecutor } from "../../types";

/** Fixtures shared by adapter/API integration tests. Their labels are the only
 * namespace lab cleanup and event assertions may use. */
export const SWARM_FIXTURE_LABEL = "com.openship.swarm.fixture";
export const SWARM_FIXTURE_STACK = "openship-swarm-fixture";

export interface SwarmTaskFixture {
  id: string;
  name: string;
  currentState: string;
  desiredState: string;
  error?: string;
}

export interface SwarmEventFixture {
  action: string;
  actorId: string;
  timeNano: number;
  attributes: Record<string, string>;
}

function assertFixtureStackName(stackName: string): void {
  if (stackName !== SWARM_FIXTURE_STACK) {
    throw new Error(`Refusing to inspect non-fixture Swarm stack: ${stackName}`);
  }
}

function sh(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

/** Read task state from the fixture stack without mutating any Docker resource. */
export async function readFixtureTasks(
  executor: Pick<CommandExecutor, "exec">,
  stackName = SWARM_FIXTURE_STACK,
): Promise<SwarmTaskFixture[]> {
  assertFixtureStackName(stackName);
  const output = await executor.exec(
    `docker stack ps ${sh(stackName)} --no-trunc --format '{{json .}}'`,
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, string>)
    .map((task) => ({
      id: task.ID ?? "",
      name: task.Name ?? "",
      currentState: task.CurrentState ?? "",
      desiredState: task.DesiredState ?? "",
      ...(task.Error ? { error: task.Error } : {}),
    }));
}

/** Polls an injected read-only task snapshot until the caller's convergence
 * predicate holds. Tests can use it with the live lab or deterministic data. */
export async function waitForFixtureConvergence(
  read: () => Promise<SwarmTaskFixture[]>,
  isConverged: (tasks: SwarmTaskFixture[]) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<SwarmTaskFixture[]> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const tasks = await read();
    if (isConverged(tasks)) return tasks;
    if (Date.now() >= deadline) {
      throw new Error(`Fixture stack did not converge within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
