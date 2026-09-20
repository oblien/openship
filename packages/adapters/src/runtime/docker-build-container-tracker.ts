/**
 * Tracks the exact intermediate container announced by Docker's legacy build
 * stream. This is intentionally a stream state machine, not a host-wide search:
 * creation time, memory percentage, and recency cannot establish ownership.
 */

export interface LegacyBuildContainerInspect {
  Id?: string;
  Config?: {
    Image?: string;
    Cmd?: string[] | null;
  };
  HostConfig?: {
    Memory?: number;
    ExtraHosts?: string[] | null;
  };
  State?: {
    Running?: boolean;
  };
}

export interface LegacyBuildContainerClient {
  inspect(id: string): Promise<LegacyBuildContainerInspect | null>;
  kill(id: string): Promise<void>;
}

interface BuildStep {
  number: number;
  total: number;
  instruction: string;
  parentImageId: string | null;
}

interface Candidate extends BuildStep {
  id: string;
}

export type LegacyBuildContainerTermination =
  | { status: "none" }
  | { status: "not-running"; id: string }
  | { status: "unverified"; id: string }
  | { status: "killed"; id: string };

function normalizedImageId(value: string | undefined): string {
  return (value ?? "").replace(/^sha256:/, "").toLowerCase();
}

function commandMatches(instruction: string, actual: string[] | null | undefined): boolean {
  const run = instruction.match(/^RUN\s+([\s\S]+)$/i)?.[1]?.trim();
  if (!run || !actual?.length) return false;

  // Exec-form RUN is stored as the argv itself. Shell-form RUN is stored as
  // `<configured shell> -c <command>`, so its final argv item is authoritative
  // even when the image changed SHELL away from /bin/sh.
  if (run.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(run);
      return (
        Array.isArray(parsed) &&
        parsed.every((part) => typeof part === "string") &&
        parsed.length === actual.length &&
        parsed.every((part, index) => part === actual[index])
      );
    } catch {
      return false;
    }
  }
  return actual[actual.length - 1] === run;
}

/**
 * Provenance tracker for one classic-builder response stream.
 *
 * The first `Running in <id>` after a Docker `Step N/M : RUN ...` arrives
 * before that RUN can emit user-controlled stdout. While that container is
 * alive, all apparent Docker markers from its stdout are ignored. A matching
 * removal marker clears it only after daemon inspection confirms it stopped or
 * disappeared. Before a kill, inspection must also find the unguessable
 * per-build ExtraHosts marker plus the expected parent image, command, and
 * memory cap. A Dockerfile can print fake progress lines, but it cannot attach
 * that marker to an unrelated container.
 */
export class LegacyBuildContainerTracker {
  private parentImageId: string | null = null;
  private pendingStep: BuildStep | null = null;
  private active: Candidate | null = null;
  private expectedStepTotal: number | null = null;
  private lastStepNumber = 0;
  private chunkBuffer = "";
  private queue: Promise<void> = Promise.resolve();
  private termination: Promise<LegacyBuildContainerTermination> | null = null;

  constructor(
    private readonly client: LegacyBuildContainerClient,
    private readonly expectedMemoryBytes: number | undefined,
    private readonly ownershipHost: string,
  ) {}

  /** Consume one complete dockerode `event.stream` field. */
  observe(stream: string | undefined): void {
    if (!stream) return;
    for (const rawLine of stream.split(/\r?\n/)) {
      this.enqueueLine(rawLine);
    }
  }

  /** Consume an arbitrary SSH stdout/stderr chunk, retaining a partial line. */
  observeChunk(chunk: string | undefined): void {
    if (!chunk) return;
    const parts = `${this.chunkBuffer}${chunk}`.split(/\r\n|\n|\r/);
    this.chunkBuffer = parts.pop() ?? "";
    // A process can stream an unlimited line. Docker's structural markers are
    // tiny, so retain only a bounded suffix while waiting for a delimiter.
    if (this.chunkBuffer.length > 8_192) this.chunkBuffer = this.chunkBuffer.slice(-8_192);
    for (const line of parts) this.enqueueLine(line);
  }

  flush(): void {
    this.enqueueLine(this.chunkBuffer);
    this.chunkBuffer = "";
  }

  private enqueueLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;
    this.queue = this.queue.then(
      () => this.observeLine(line),
      () => this.observeLine(line),
    );
  }

  private async observeLine(line: string): Promise<void> {
    if (this.active) {
      const removed = line.match(/^---> Removed intermediate container\s+([a-f0-9]{12,64})$/i);
      if (removed?.[1]?.toLowerCase() === this.active.id) {
        // User code can print a byte-identical marker. Do not trust it until the
        // daemon says this exact candidate has really stopped/disappeared.
        try {
          const info = await this.client.inspect(this.active.id);
          if (!info?.State?.Running) this.active = null;
        } catch {
          // A transient inspection failure is not proof that ownership ended.
        }
      }
      return;
    }

    const layer = line.match(/^--->\s+([a-f0-9]{12,64})$/i);
    if (layer?.[1]) {
      this.parentImageId = layer[1].toLowerCase();
      return;
    }

    const step = line.match(/^Step\s+(\d+)\/(\d+)\s*:\s*([\s\S]+)$/i);
    if (step?.[1] && step[2] && step[3]) {
      const number = Number(step[1]);
      const total = Number(step[2]);
      // Docker's legacy stream is monotonic. Refuse malformed counters rather
      // than loosening the state machine around user-controlled build output.
      const firstStep = this.lastStepNumber === 0 && number === 1;
      const nextStep = number === this.lastStepNumber + 1;
      const sameTotal = this.expectedStepTotal === null || total === this.expectedStepTotal;
      if (number >= 1 && total >= number && sameTotal && (firstStep || nextStep)) {
        this.expectedStepTotal ??= total;
        this.lastStepNumber = number;
        this.pendingStep = {
          number,
          total,
          instruction: step[3].trim(),
          parentImageId: this.parentImageId,
        };
      }
      return;
    }

    const running = line.match(/^---> Running in\s+([a-f0-9]{12,64})$/i);
    if (running?.[1] && this.pendingStep && /^RUN\s+/i.test(this.pendingStep.instruction)) {
      this.active = { ...this.pendingStep, id: running[1].toLowerCase() };
      this.pendingStep = null;
    }
  }

  private async terminate(): Promise<LegacyBuildContainerTermination> {
    await this.queue;
    const candidate = this.active;
    if (!candidate) return { status: "none" };

    const info = await this.client.inspect(candidate.id);
    if (!info?.State?.Running) return { status: "not-running", id: candidate.id };

    const actualId = info.Id?.toLowerCase() ?? "";
    const actualImage = normalizedImageId(info.Config?.Image);
    const expectedMemory = this.expectedMemoryBytes ?? 0;
    const ownershipEntry = `${this.ownershipHost}:127.0.0.1`;
    const verified =
      actualId.startsWith(candidate.id) &&
      candidate.parentImageId !== null &&
      actualImage.startsWith(candidate.parentImageId) &&
      (info.HostConfig?.Memory ?? 0) === expectedMemory &&
      info.HostConfig?.ExtraHosts?.includes(ownershipEntry) === true &&
      commandMatches(candidate.instruction, info.Config?.Cmd);

    if (!verified) return { status: "unverified", id: candidate.id };
    await this.client.kill(candidate.id);
    return { status: "killed", id: candidate.id };
  }

  terminateActive(): Promise<LegacyBuildContainerTermination> {
    return (this.termination ??= this.terminate());
  }
}
