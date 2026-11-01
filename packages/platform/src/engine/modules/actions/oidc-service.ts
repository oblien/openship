import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK, exportPKCS8, importPKCS8, SignJWT, type JWK } from "jose";
import { AppError, actionFinished } from "@repo/core";
import type { ActionJob, ActionRun } from "@repo/db";
import { ActionRuntimeTokens, type ActionRuntimeIdentity } from "./runtime-identity";

type SigningKey = {
  id: string;
  kid: string;
  privateKeyEnc: string;
  publicKey: Record<string, string>;
};
export interface ActionOidcPorts {
  issuer(): string;
  tokens: ActionRuntimeTokens;
  key(issuer: string): Promise<SigningKey | undefined>;
  ensureKey(value: SigningKey): Promise<SigningKey>;
  encrypt(value: string): string;
  decrypt(value: string): string;
  /** Rechecks actor, workflow policy, approval, destination and cancellation. */
  authorize(identity: ActionRuntimeIdentity): Promise<{ run: ActionRun; job: ActionJob }>;
}

const denied = () =>
  new AppError("This job cannot request an identity token", 403, "ACTIONS_OIDC_FORBIDDEN");
export function assertOidcJob(run: ActionRun, job: ActionJob) {
  if (
    run.controller !== "openship" ||
    run.status !== "running" ||
    run.untrusted ||
    run.cancelRequestedAt ||
    run.finishedAt ||
    actionFinished(run.status) ||
    job.runId !== run.id ||
    job.organizationId !== run.organizationId ||
    job.status !== "running" ||
    job.cancelRequestedAt ||
    job.finishedAt ||
    job.cleanedAt ||
    actionFinished(job.status) ||
    !job.workerStartedAt ||
    !job.runnerId ||
    job.spec?.permissions["id-token"] !== "write"
  )
    throw denied();
}

/** The only issuer of job identities. Its public key is separate from session,
 * artifact and request capabilities; no symmetric signing key is published. */
export class ActionOidcService {
  private keys = new Map<
    string,
    Promise<{ row: SigningKey; privateKey: Awaited<ReturnType<typeof importPKCS8>> }>
  >();
  constructor(private readonly ports: ActionOidcPorts) {}

  private async signingKey() {
    const issuer = this.ports.issuer();
    let pending = this.keys.get(issuer);
    if (!pending) {
      pending = (async () => {
        let row = await this.ports.key(issuer);
        if (!row) {
          const pair = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
          const publicKey = await exportJWK(pair.publicKey);
          row = await this.ports.ensureKey({
            id: issuer,
            kid: randomUUID(),
            publicKey: publicKey as Record<string, string>,
            privateKeyEnc: this.ports.encrypt(await exportPKCS8(pair.privateKey)),
          });
        }
        // A restored instance without its encrypted credentials must not quietly
        // replace an existing issuer identity with a new key.
        if (!row.privateKeyEnc)
          throw new AppError(
            "This OIDC signing key was transferred without credentials. Restore an instance archive that includes its credentials to use this issuer.",
            409,
            "ACTIONS_OIDC_CREDENTIALS_MISSING",
          );
        const privateKey = await importPKCS8(this.ports.decrypt(row.privateKeyEnc), "RS256");
        return { row, privateKey };
      })();
      this.keys.set(issuer, pending);
    }
    try {
      return await pending;
    } catch (error) {
      if (this.keys.get(issuer) === pending) this.keys.delete(issuer);
      throw error;
    }
  }

  discovery() {
    const issuer = this.ports.issuer();
    return {
      issuer,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      claims_supported: [
        "iss",
        "sub",
        "aud",
        "exp",
        "iat",
        "nbf",
        "jti",
        "repository",
        "repository_id",
        "repository_owner",
        "repository_owner_id",
        "ref",
        "sha",
        "workflow_ref",
        "workflow_sha",
        "job_workflow_ref",
        "job_workflow_sha",
        "run_id",
        "run_number",
        "run_attempt",
        "actor",
        "actor_id",
        "event_name",
        "runner_environment",
        "openship_organization_id",
        "openship_job_id",
        "openship_runner_id",
        "openship_workflow_modified",
      ],
    };
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    // Verification of already issued identities does not require the private
    // key, including when an archive intentionally omits its credentials.
    const row = (await this.ports.key(this.ports.issuer())) ?? (await this.signingKey()).row;
    // Whitelist RSA public parameters even if stored metadata is malformed.
    const { kty, n, e } = row.publicKey;
    return { keys: [{ kty, n, e, kid: row.kid, alg: "RS256", use: "sig" }] };
  }

  async environment(run: ActionRun, job: ActionJob): Promise<Record<string, string>> {
    if (job.spec?.permissions["id-token"] !== "write" || run.untrusted) return {};
    const issuer = this.ports.issuer();
    await this.signingKey();
    return {
      ACTIONS_ID_TOKEN_REQUEST_URL: `${issuer}/token?job=${encodeURIComponent(job.id)}`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: await this.ports.tokens.issue(
        { purpose: "oidc", organizationId: run.organizationId, runId: run.id, jobId: job.id },
        job.spec.timeoutSeconds + 300,
      ),
    };
  }

  async token(request: Request) {
    const bearer = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    const identity = await this.ports.tokens.verify(bearer, "oidc");
    const url = new URL(request.url);
    if (url.searchParams.get("job") !== identity.jobId) throw denied();
    const audience =
      url.searchParams.get("audience") ??
      `${this.ports.issuer()}/organizations/${encodeURIComponent(identity.organizationId)}`;
    if (
      !audience.trim() ||
      audience.length > 512 ||
      /[\x00-\x20\x7f]/.test(audience) ||
      url.searchParams.getAll("audience").length > 1
    )
      throw new AppError(
        "OIDC audience must be a non-empty value of at most 512 characters without whitespace",
        400,
        "ACTIONS_OIDC_AUDIENCE_INVALID",
      );
    const { run, job } = await this.ports.authorize(identity);
    if (
      run.id !== identity.runId ||
      run.organizationId !== identity.organizationId ||
      job.id !== identity.jobId
    )
      throw denied();
    assertOidcJob(run, job);
    const { row, privateKey } = await this.signingKey();
    const { owner, repo, workflows } = run.configuration;
    const root = workflows?.root;
    const called = job.spec?.scope?.at(-1);
    const callee = called && workflows?.[called.sourceId];
    const encode = (value: string) => encodeURIComponent(value).replace(/%2F/gi, "/");
    const subject = `openship:organization:${encode(run.organizationId)}:${owner && repo ? `repo:${encode(`${owner}/${repo}`)}:ref:${encode(run.ref)}` : `workflow:${encode(run.workflowId)}`}${root?.modified ? ":source:override" : ""}`;
    const workflowRef = (value: NonNullable<typeof root>) =>
      `${value.owner}/${value.repo}/${value.path}@${value.ref}`;
    const repository = run.event.repository as { id?: number; owner?: { id?: number } } | undefined;
    const actor = run.configuration.actorIdentity;
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      openship_organization_id: run.organizationId,
      openship_job_id: job.id,
      openship_runner_id: job.runnerId,
      openship_workflow_modified: !!root?.modified,
      ...(owner && repo && { repository: `${owner}/${repo}`, repository_owner: owner }),
      ...(Number.isSafeInteger(repository?.id) && { repository_id: String(repository!.id) }),
      ...(Number.isSafeInteger(repository?.owner?.id) && {
        repository_owner_id: String(repository!.owner!.id),
      }),
      ref: run.ref,
      sha: run.revision,
      event_name: run.eventName,
      workflow: run.plan.name,
      run_id: run.id,
      run_number: String(run.number),
      run_attempt: String(run.attempt),
      actor: actor?.login ?? run.actor,
      actor_id: actor?.id ?? run.authority.userId,
      runner_environment: "self-hosted",
      ...(root?.owner && { workflow_ref: workflowRef(root), workflow_sha: root.sha }),
      ...(callee && { job_workflow_ref: workflowRef(callee), job_workflow_sha: callee.sha }),
    })
      .setProtectedHeader({ alg: "RS256", kid: row.kid, typ: "JWT" })
      .setIssuer(this.ports.issuer())
      .setSubject(subject)
      .setAudience(audience)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(Math.min(now + 300, identity.exp))
      .setJti(randomUUID())
      .sign(privateKey);
    return { value: token };
  }
}
