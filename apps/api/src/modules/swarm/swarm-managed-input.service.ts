/** Permission-scoped, redacted CRUD for operator-entered Swarm resources. */

import { AppError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import { decryptSecretField, encryptSecretField } from "../../lib/credential-encryption";

function safeLogicalName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) {
    throw new AppError("A managed Swarm resource name is invalid.", 400, "SWARM_MANAGED_INPUT_NAME_INVALID");
  }
  return name;
}

export async function listManagedInputs(projectId: string, organizationId: string) {
  const inputs = await repos.swarmStack.listManagedInputsInOrganization(projectId, organizationId);
  return inputs.map(({ valueEnc: _valueEnc, ...input }) => ({ ...input, hasValue: true }));
}

export async function saveManagedInput(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  kind: "config" | "secret";
  logicalName: string;
  value: string;
}) {
  if (!input.value) throw new AppError("A managed Swarm resource value is required.", 400, "SWARM_MANAGED_INPUT_VALUE_REQUIRED");
  const row = await repos.swarmStack.upsertManagedInputInOrganization(input.projectId, input.organizationId, {
    kind: input.kind,
    logicalName: safeLogicalName(input.logicalName),
    valueEnc: encryptSecretField(input.value)!,
    createdByUserId: input.userId,
    updatedByUserId: input.userId,
  });
  if (!row) throw new NotFoundError("Project", input.projectId);
  const { valueEnc: _valueEnc, ...safe } = row;
  return { ...safe, hasValue: true };
}

export async function removeManagedInput(id: string, organizationId: string): Promise<void> {
  if (!await repos.swarmStack.removeManagedInputInOrganization(id, organizationId)) {
    throw new NotFoundError("Managed Swarm resource", id);
  }
}

/** Deployment-only decryption; callers must never expose this return value. */
export async function resolveManagedInputPayloads(projectId: string, organizationId: string) {
  const inputs = await repos.swarmStack.listManagedInputsInOrganization(projectId, organizationId);
  return inputs.map((input) => {
    const content = decryptSecretField(input.valueEnc);
    if (!content) throw new AppError("A managed Swarm resource payload is unavailable.", 409, "SWARM_MANAGED_INPUT_UNAVAILABLE");
    return { kind: input.kind, logicalName: input.logicalName, content };
  });
}
