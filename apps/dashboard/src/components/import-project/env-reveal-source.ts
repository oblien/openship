/**
 * Which source can hand back the REAL value of a masked env row — the decision behind
 * whether a row gets a reveal affordance at all.
 *
 * This is the rule that broke. A masked row holds only the mask sentinel, so the editor
 * hides its eye when nothing can resolve that sentinel — otherwise the toggle would
 * "reveal" the dots themselves. Correct in isolation, but the compose wizard only ever
 * wired the UPLOAD source, so an edit of an existing compose project rendered rows that
 * were unreadable AND unrevealable: dots, no eye, no way to see the value you came to
 * change. Two services on one page could even disagree — a row with an empty value
 * isn't masked, so it kept its eye while its masked neighbours had none, which is what
 * "some env have no show button" looks like from the outside.
 *
 * Its own module because the answer depends on three fields that arrive from three
 * different places (the upload session on the wizard config, the project id on that
 * same config, the service id carried only by a PERSISTED service row) and because the
 * `null` case is a real answer, not a missing one — see below.
 */

/** Where the unmasked values come from. `null` = nothing can resolve them here. */
export type EnvRevealSource =
  | { kind: "upload"; sessionId: string; service: string }
  | { kind: "service"; projectId: string; serviceId: string }
  | null;

export function envRevealSource(input: {
  /** Set while a folder-upload scan session is alive. */
  uploadSessionId?: string;
  /** Set once the wizard is bound to a project (an edit / redeploy). */
  projectId?: string;
  /** Carried only by a service hydrated from a persisted row. */
  serviceId?: string;
  /** Scopes an upload reveal to ONE service, so a sibling's secrets don't ride along. */
  serviceName: string;
}): EnvRevealSource {
  // Upload first: while a scan session is open, its values are the ones on screen —
  // they may not be saved anywhere yet, so the service row (if any) would answer about
  // a different, older set of values.
  if (input.uploadSessionId) {
    return { kind: "upload", sessionId: input.uploadSessionId, service: input.serviceName };
  }
  // A persisted service: its stored env is what the mask is hiding. Needs BOTH ids —
  // the endpoint is addressed by service id under a project, and a service id without
  // a project id is not something we can ask about.
  if (input.projectId && input.serviceId) {
    return { kind: "service", projectId: input.projectId, serviceId: input.serviceId };
  }
  // Nothing to reveal, and that is the right answer rather than a gap to paper over: a
  // FIRST compose deploy off git has no upload session and no saved row, so the values
  // in hand came straight from the compose file and were never masked to begin with.
  // Inventing a source here would mean asking the server about a service that does not
  // exist yet.
  return null;
}
