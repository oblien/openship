import { isDeepStrictEqual } from "node:util";
import type { PaidMailPlan, MailProduct } from "@repo/core/managed-mail";
import { AppError, PRICING } from "@repo/core";
import type {
  MailChangeSelection,
  MailPlanChangeQuote,
  MailPlanAllowance,
  BillingPlanChange,
} from "@repo/contracts";
import { repos, type MailChangeIntent, type DedicatedMailOrder } from "@repo/db";
import { getOblienBillingApi, getOblienClient } from "../../lib/oblien-client";
import { createProvisionLock } from "../../lib/provision-lock";
import { syncNamespaceResourceLimits } from "../../lib/cloud-resource-limits";
import { resizeDockerWorkspace } from "../../lib/cloud-docker-workspace";
import { assertBillingEnabled } from "../billing/billing.service";
import {
  canChangeCloudSubscription,
  hasPendingSubscriptionChange,
  presentSubscriptionChange,
} from "../billing/billing-subscription";
import {
  acceptChange,
  previewChange,
  readAcceptedChange,
  matchesAppliedSubscription,
  requestKey,
  terminal,
} from "../billing/subscription-change-lifecycle";
import {
  dedicated,
  dedicatedCoverage,
  dedicatedOffer,
  dedicatedOrderTerms,
  orderLock,
} from "./dedicated";
import { mailServiceOffer, paidEmailPlan, sendingNamespace } from "./billing";
import { reconcileSending } from "./sending";
import { mailEngines } from "./service";

const lock = (org: string, target: string) =>
  target === "account" ? createProvisionLock("managed-mail:checkout:" + org) : orderLock(org);

async function load(org: string, target: string) {
  if (target === "account") {
    const account = await repos.managedMail.account(org);
    if (!account?.namespaceReady || account.namespace !== sendingNamespace(org))
      throw new AppError("Mail subscription not found.", 404);
    return {
      namespace: account.namespace,
      change: account.change,
      row: null,
      save: (change: MailChangeIntent) => repos.managedMail.updateAccount(org, { change }),
    };
  }
  const row = await repos.managedMail.service(org, target);
  dedicated(row);
  if (row.orderState !== "funded")
    throw new AppError("Finish the dedicated mail purchase first.", 409);
  return {
    namespace: row.billingNamespace,
    change: row.change,
    row,
    save: (change: MailChangeIntent) => repos.managedMail.updateOrder(org, row.id, { change }),
  };
}

type Owner = Awaited<ReturnType<typeof load>>;
async function readMailVm(row: NonNullable<Owner["row"]>) {
  if (!row.cloudServerId || row.provisioning)
    throw new AppError(
      "Wait for the dedicated mail server to finish setup before expanding its disk.",
      409,
    );
  const vm = await getOblienClient().vms.get(row.cloudServerId);
  if (
    vm.namespace !== row.billingNamespace ||
    vm.id !== row.cloudServerId ||
    vm.slug !== row.billingNamespace ||
    !vm.resources
  )
    throw new AppError(
      "The dedicated mail VM could not be verified.",
      409,
      "CLOUD_WORKSPACE_CHANGED",
    );
  return {
    id: vm.id,
    allocation: {
      cpuCores: vm.resources.cpus,
      memoryMb: vm.resources.memory_mb,
      diskMb: vm.resources.disk_size_mb,
    },
  };
}

async function resizePreview(
  owner: Owner,
  next?: DedicatedMailOrder,
): Promise<MailChangeIntent["resize"]> {
  const row = owner.row;
  if (!row || !next || row.order.storageGB === next.storageGB) return null;
  if (next.storageGB < row.order.storageGB)
    throw new AppError("Keep the existing disk size or choose a larger size.", 409);
  if (!row.order.worker) {
    const capacity = mailEngines().find(
      (engine) => engine.providerVmId === row.cloudServerId,
    )?.mailboxStorageMB;
    if (capacity !== undefined && next.storageGB * 1024 > capacity)
      throw new AppError("This mail host cannot provide the selected mailbox storage.", 409);
  }
  const vm = await readMailVm(row);
  const before = {
    cpuCores: row.order.cpuCores,
    memoryMb: row.order.memoryMB,
    diskMb: row.order.diskGB * 1024,
  };
  if (!isDeepStrictEqual(vm.allocation, before))
    throw new AppError(
      "The mail server allocation changed. Refresh before resizing.",
      409,
      "CLOUD_WORKSPACE_CHANGED",
    );
  const after = { ...before, diskMb: next.diskGB * 1024 };
  return {
    before,
    after,
    revision: requestKey(vm.id, JSON.stringify([before, after])),
    restartProjects: [{ id: row.id, name: row.hostname ?? "OpenShip Mail" }],
  };
}

function allowance(
  plan: PaidMailPlan,
  product: MailProduct,
  order?: DedicatedMailOrder,
): MailPlanAllowance {
  const limits = PRICING.mail.plans[plan];
  const { domains, recipients } = order?.allowance ?? limits;
  return {
    domains,
    recipients,
    ...(product === "mailboxes" && {
      mailboxes: limits.mailboxes,
      storageGB: limits.storageMB / 1024,
    }),
    ...(order && { storageGB: order.storageGB }),
  };
}

export async function previewMailChange(
  org: string,
  target: string,
  input: MailChangeSelection,
): Promise<MailPlanChangeQuote> {
  assertBillingEnabled();
  return lock(org, target).run(async () => {
    const owner = await load(org, target);
    const { subscription } = await getOblienBillingApi().getSubscription(owner.namespace);
    if (
      !subscription?.offer ||
      !canChangeCloudSubscription(subscription) ||
      hasPendingSubscriptionChange(owner.change)
    )
      throw new AppError("Finish the pending change or payment before changing this plan.", 409);
    if (!PRICING.mail.plans[input.plan].checkoutAvailable)
      throw new AppError("This plan is unavailable.", 409);
    let offer;
    let currentPlan: PaidMailPlan;
    let currentProduct: MailProduct;
    let nextOrder: DedicatedMailOrder | undefined;
    const metadata = { ...subscription.metadata };
    if (owner.row) {
      if (input.product) throw new AppError("Change dedicated mail through its VM plan.", 400);
      if (!(await dedicatedCoverage(owner.row)))
        throw new AppError("An active dedicated subscription is required.", 409);
      currentPlan = owner.row.order.plan;
      currentProduct = "dedicated";
      nextOrder = dedicatedOrderTerms(
        input.plan,
        input.storageGB ?? owner.row.order.storageGB,
        owner.row.order,
      );
      offer = dedicatedOffer({ ...owner.row, order: nextOrder });
    } else {
      const paid = await paidEmailPlan(org);
      if (!paid || input.storageGB !== undefined)
        throw new AppError("Select an active mail subscription.", 409);
      currentPlan = paid.plan;
      currentProduct = paid.sendingOnly ? "sending" : "mailboxes";
      offer = mailServiceOffer(input.plan, input.product ?? currentProduct);
      metadata.openship_mail_plan = input.plan;
      if (input.product) metadata.openship_mail_product = input.product;
    }
    if (isDeepStrictEqual(subscription.offer, offer))
      throw new AppError("This is your current plan.", 409);
    const resize = await resizePreview(owner, nextOrder);
    const quote = await previewChange(
      owner.namespace,
      subscription.offer,
      {
        offer,
        metadata,
        billingInterval: "monthly",
        idempotencyKey: requestKey("preview", org, target, input.idempotencyKey),
      },
      resize,
      (intent) => owner.save({ ...intent, nextOrder }),
    );
    return {
      ...quote,
      allowances: {
        current: allowance(currentPlan, currentProduct, owner.row?.order),
        next: allowance(input.plan, input.product ?? currentProduct, nextOrder),
      },
    };
  });
}

export async function confirmMailChange(org: string, target: string, quoteId: string) {
  assertBillingEnabled();
  return lock(org, target).run(async () => {
    const owner = await load(org, target);
    const change = await acceptChange(
      owner.namespace,
      [org, target],
      owner.change,
      quoteId,
      () => resizePreview(owner, owner.change?.nextOrder),
      (intent) => owner.save({ ...owner.change, ...intent }),
    );
    return status(change, owner.change);
  });
}

function status(
  change: Parameters<typeof presentSubscriptionChange>[0],
  intent?: MailChangeIntent | null,
): BillingPlanChange {
  return {
    ...presentSubscriptionChange(change),
    ...(change.status === "applied" && !intent?.completed ? { serverUpdate: "pending" } : {}),
  };
}

export async function mailChangeStatus(org: string, target: string, changeId?: string) {
  const owner = await load(org, target);
  const intent = owner.change;
  if (changeId && changeId !== intent?.changeId)
    throw new AppError("Mail plan change not found.", 404);
  if (!intent?.changeId || (intent.completed && !changeId))
    return { change: null, pending: hasPendingSubscriptionChange(intent) };
  const { change } = await getOblienBillingApi().getPlanChange(owner.namespace, intent.changeId);
  return { change: status(change, intent), pending: hasPendingSubscriptionChange(intent) };
}

export async function cancelMailChange(org: string, target: string, id: string) {
  return lock(org, target).run(async () => {
    const owner = await load(org, target);
    if (!owner.change || owner.change.changeId !== id)
      throw new AppError("Mail plan change not found.", 404);
    const { change } = await getOblienBillingApi().cancelPlanChange(
      owner.namespace,
      id,
      requestKey("cancel", org, target, id),
    );
    if (terminal(change) && change.status !== "applied")
      await owner.save({ ...owner.change, completed: true });
    return status(change, owner.change);
  });
}

/** A webhook or recovery tick resumes persisted consent, including workloads stopped by a disk resize. */
export async function reconcileMailChange(org: string, target: string) {
  return lock(org, target).run(async () => {
    const owner = await load(org, target);
    if (!owner.change?.confirmationKey || owner.change.completed) return;
    let intent = owner.change;
    const change = await readAcceptedChange(owner.namespace, intent, async (next) => {
      intent = { ...intent, ...next };
      await owner.save(intent);
    });
    if (!terminal(change)) return;
    if (change.status !== "applied") return owner.save({ ...intent, completed: true });
    const provider = getOblienBillingApi();
    const { subscription } = await provider.getSubscription(owner.namespace);
    if (!matchesAppliedSubscription(subscription, intent)) {
      // Provider events can arrive before the subscription read reflects the applied offer.
      if (!subscription || subscription.status === "canceled")
        await owner.save({ ...intent, completed: true });
      return;
    }
    if (owner.row && intent.nextOrder) {
      const nextOrder = intent.nextOrder;
      if (!(await dedicatedCoverage(owner.row))) return;
      if (intent.resize && !intent.serverUpdate) {
        const vm = await readMailVm(owner.row);
        if (
          !isDeepStrictEqual(vm.allocation, intent.resize.before) &&
          !isDeepStrictEqual(vm.allocation, intent.resize.after)
        )
          throw new AppError(
            "The dedicated VM allocation changed after confirmation.",
            409,
            "CLOUD_WORKSPACE_CHANGED",
          );
        await syncNamespaceResourceLimits(
          owner.namespace,
          dedicatedOffer({ ...owner.row, order: nextOrder }).resourceLimits,
        );
        await resizeDockerWorkspace({
          client: getOblienClient(),
          namespace: owner.namespace,
          workspaceId: vm.id,
          resources: intent.resize.after,
          restartCheckpoint: {
            workloads: intent.restartWorkloads,
            save: async (restartWorkloads) => {
              intent = { ...intent, restartWorkloads };
              await owner.save(intent);
            },
          },
        });
      }
      intent = { ...intent, serverUpdate: "not_required" };
      await repos.managedMail.updateOrder(org, target, {
        change: intent,
        order: {
          ...nextOrder,
          worker: owner.row.order.worker,
          purchase: owner.row.order.purchase ?? {
            plan: owner.row.order.plan,
            storageGB: owner.row.order.storageGB,
            monthlyCents: dedicatedOffer(owner.row).unitAmount,
          },
        },
      });
    } else if (!(await paidEmailPlan(org))) return;
    const sendingEnabled = !!(await repos.managedMail.account(org))?.sendingEnabled;
    if (sendingEnabled) await reconcileSending(org);
    await owner.save({ ...intent, completed: true });
    return sendingEnabled;
  });
}
