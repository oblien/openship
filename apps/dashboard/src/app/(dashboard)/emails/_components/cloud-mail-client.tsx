"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ManagedMailSummary, type MailPlacement } from "@repo/contracts/managed-mail";
import { getActiveOrganizationId, subscribeActiveOrganization } from "@/lib/api/client";
import { managedMailApi } from "@/lib/api/managed-mail";
import { getApiErrorMessage } from "@/lib/api";
import { useScopedMutation } from "@/hooks/use-scoped-resource";
import { mailPlanLabel } from "@/components/billing/plan-presentation";
import { Icon } from "@repo/ui/icons";
import { CloudMailSetup } from "./cloud-mail-setup";
import DropdownMenu from "@/components/ui/DropdownMenu";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { MailAdminPanel } from "./admin/admin-panel";
import { changeMailPlanHref, emailPlansHref, parseMailProduct } from "@repo/core/managed-mail";
import { CloudMailAccess, ExistingMailConnection, MailWelcomeCard } from "./cloud-mail-access";
import { ManagedSending } from "./admin/managed-sending";

export function CloudMailClient({ instanceHref }: { instanceHref?: string } = {}) {
  const org = useSyncExternalStore(
    subscribeActiveOrganization,
    getActiveOrganizationId,
    () => null,
  );
  const query = useSearchParams();
  const returnedOrg = query.get("organizationId");
  if (returnedOrg && returnedOrg !== org)
    return (
      <PageContainer>
        <p>Switch to the organization that started this email checkout to view its subscription.</p>
        <Button variant="link" asChild>
          <Link href="/emails">View email for the current organization</Link>
        </Button>
      </PageContainer>
    );
  if (query.get("mailPlan") || query.get("mailView") === "plans")
    return (
      <MailRedirect
        href={emailPlansHref(
          query.get("mailPlan"),
          org,
          parseMailProduct(query.get("mailProduct")),
          Number(query.get("storageGB")) || undefined,
        )}
      />
    );
  return (
    <CloudMailService
      key={org + ":" + (query.get("serviceId") ?? "")}
      organizationId={org}
      instanceHref={instanceHref}
    />
  );
}

function MailRedirect({ href, label }: { href: string; label?: string }) {
  const router = useRouter();
  const { t } = useI18n();
  useEffect(() => {
    router.replace(href);
  }, [href, router]);
  return (
    <PageContainer>
      <Link href={href}>{label ?? t.emails.cloudClient.browsePlans}</Link>
    </PageContainer>
  );
}

function CloudMailService({
  organizationId,
  instanceHref,
}: {
  organizationId: string | null;
  instanceHref?: string;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<ManagedMailSummary>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [finishedAttempt, setFinishedAttempt] = useState(0);
  const provisioningPending = useRef(false);
  const [busy, setBusy] = useState(false);
  const checkout = useScopedMutation();
  const params = useSearchParams();
  const selectedService = params.get("serviceId");
  const path = usePathname();
  const router = useRouter();
  const copy = t.emails.cloudClient;
  function href(view: "overview" | "sending" | "connect", senderId?: string) {
    const query = new URLSearchParams(params.toString());
    query.delete("mailPlan");
    query.delete("tab");
    query.delete("domain");
    query.delete("senderId");
    query.delete("senderView");
    if (view === "overview") query.delete("mailView");
    else query.set("mailView", view);
    if (senderId) query.set("senderId", senderId);
    return query.size ? path + "?" + query : path;
  }
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = selectedService
          ? await managedMailApi.service(selectedService)
          : await managedMailApi.summary();
        if (!current) return;
        provisioningPending.current = !!result.service?.provisioning;
        setData(result);
        setError("");
      } catch (e) {
        if (current) setError(getApiErrorMessage(e, "Could not load your email plan."));
      } finally {
        if (current) {
          setFinishedAttempt(attempt);
          if (provisioningPending.current) timer = setTimeout(refresh, 15_000);
        }
      }
    }
    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [attempt, selectedService]);
  async function activate(placement: MailPlacement, serverId?: string) {
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      const service = await managedMailApi.activate(placement, serverId);
      setData({ ...data, service });
      if (service.provisioning) {
        provisioningPending.current = true;
        setAttempt((n) => n + 1);
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Could not activate mail."));
    } finally {
      setBusy(false);
    }
  }
  const billingHref = emailPlansHref(
    data?.pendingPlan,
    organizationId,
    data?.pendingProduct ?? data?.product,
  );
  const serviceHref = useCallback(
    (id?: string) => {
      const query = new URLSearchParams(params.toString());
      for (const key of ["mailView", "tab", "domain", "serviceId", "senderId", "senderView"]) query.delete(key);
      if (id) query.set("serviceId", id);
      return path + (query.size ? "?" + query : "");
    },
    [path, params],
  );
  const existingMailHost = data?.services?.find(item => !item.pendingCheckout) ?? data?.services?.[0];
  const service = data?.service;
  const checkoutError = service?.provisioning === "payment" ? checkout.error : null;
  const capacity = data?.limits;
  const requestedView = params.get("mailView");
  if (
    !selectedService && !data?.plan && !service && existingMailHost &&
    requestedView !== "connect" && requestedView !== "dedicated"
  ) {
    const query = new URLSearchParams(params.toString());
    query.set("serviceId", existingMailHost.id);
    return <MailRedirect href={path + "?" + query} label={copy.openDashboard} />;
  }
  const senderPlan = !!data?.plan && !data.mailboxPlan && (data.product === "sending" || (!data.product && data.mailboxPlan === null));
  const connecting = requestedView === "connect";
  const sending = !service && (
    (senderPlan && requestedView !== "dedicated") ||
    (!data?.plan && data?.sendingConfigured && requestedView === "sending")
  );
  const placement = service?.placement ?? (data?.plan && !senderPlan ? (data.product === "dedicated" ? "dedicated" : "standard") : null);
  const access = !!data && !service && !data.plan && requestedView !== "dedicated";
  const backToMail = connecting || (sending && !senderPlan);
  const backHref = backToMail
    ? href("overview")
    : selectedService && error
      ? serviceHref()
      : instanceHref;
  const go = (target: string) => router.push(target, { scroll: false });
  const markSendingConfigured = () => setData(current => current && { ...current, sendingConfigured: true });
  const provisioning = service?.provisioning && (
    <div className="space-y-3 rounded-2xl bg-card p-5 text-sm">
      <p role="status">
        {service.provisioning === "payment"
          ? copy.paymentStatus
          : service.provisioning === "vm"
            ? copy.vmStatus
            : service.provisioning === "network"
              ? "Your VM is reserved. Installation starts once OpenShip confirms its mail worker and network routing."
              : "Preparing mail on your VM. Mailboxes will appear once DNS and webmail are ready."}
      </p>
      {service.provisioning === "payment" && (
        <Button
          disabled={checkout.busy || data?.checkoutEnabled === false || (data?.dedicatedEnrollmentEnabled ?? data?.hostedEnrollmentEnabled) === false}
          onClick={async () => {
            const result = await checkout.execute(() => managedMailApi.order(service.id, "resume"));
            if (result) window.location.assign(result.url);
          }}
        >
          {copy.resumeCheckout}
        </Button>
      )}
      {service.provisioning === "network" && data?.product !== "dedicated" && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await managedMailApi.cancelVmRequest(service.id);
              setAttempt((n) => n + 1);
            } catch (e) {
              setError(getApiErrorMessage(e, "Could not cancel this VM request."));
            } finally {
              setBusy(false);
            }
          }}
        >
          Cancel VM request
        </Button>
      )}
    </div>
  );
  return (
    <PageContainer>
      {backHref && (
        <Link
          href={backHref}
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <Icon name="arrow-left" className="size-4 rtl:rotate-180" />
          {backToMail || selectedService ? copy.title : "Back to instance mail"}
        </Link>
      )}
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-medium tracking-tight">
              {connecting ? copy.connectTitle : sending && !senderPlan ? copy.apiTitle : service || data?.plan ? "OpenShip Mail" : copy.title}
            </h1>
            {data?.plan && !connecting && (
              <span className="rounded-lg bg-secondary px-2 py-1 text-xs font-medium">
                {mailPlanLabel(data.plan, copy.included)}
              </span>
            )}
          </div>
          {!connecting && placement && requestedView !== "dedicated" && (
            <p className="mt-1 text-sm text-muted-foreground">
              {placement === "dedicated" ? copy.dedicatedTitle : copy.sharedTitle}
            </p>
          )}
        </div>
        {data && !connecting && !access && (
          <div className="flex flex-wrap items-center gap-2">
            {service && !service.provisioning && service.webmailUrl && (
              <Button asChild>
                <a href={service.webmailUrl} target="_blank" rel="noopener noreferrer">
                  {t.emailsAdmin.overview.openWebmail}<Icon name="arrow-up-right" />
                </a>
              </Button>
            )}
            {service?.webmailProjectId && (
              <Button asChild variant="secondary" size="sm">
                <Link href={`/projects/${encodeURIComponent(service.webmailProjectId)}`}>{t.importProject.deploymentProcessing.openProject}</Link>
              </Button>
            )}
            {data.subscriptionTarget && (
              <Button asChild variant="secondary" size="sm">
                <Link href={changeMailPlanHref(data.subscriptionTarget, organizationId)}>{t.billing.workspaces.changePlan}</Link>
              </Button>
            )}
            {data.pendingPlan && (
              <Button asChild variant="secondary" size="sm">
                <Link href={billingHref}>{copy.resumeCheckout}</Link>
              </Button>
            )}
            <DropdownMenu
              triggerLabel={copy.options}
              actions={[
                {
                  id: "plans",
                  label: copy.plans,
                  icon: <Icon name="credit-card" />,
                  onClick: () => go(billingHref),
                },
                {
                  id: "connect",
                  label: copy.connectAction,
                  icon: <Icon name="server" />,
                  onClick: () => go(href("connect")),
                },
                {
                  id: "apps",
                  label: copy.manageAction,
                  icon: <Icon name="mail" />,
                  onClick: () => go("/apps"),
                },
              ]}
            />
          </div>
        )}
      </header>
      {!!data?.services?.some((item) => item.plan) && !connecting && (
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            {copy.hostingTitle}
            <select
              className="max-w-full rounded-lg border bg-card px-3 py-2"
              value={service?.id ?? ""}
              onChange={(e) => go(serviceHref(e.target.value))}
            >
              {data.defaultProduct && !data.services.some((item) => !item.plan) && (
                <option value="">
                  {data.defaultProduct === "sending" ? copy.apiTitle : copy.sharedTitle}
                </option>
              )}
              {data.services.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.hostname ??
                    (item.plan
                      ? copy.dedicatedTitle + " · " + item.plan + " · " + item.id.slice(-6)
                      : copy.sharedTitle)}
                </option>
              ))}
            </select>
          </label>
          <Button asChild variant="link">
            <Link href={emailPlansHref(null, organizationId, "dedicated")}>{copy.browsePlans}</Link>
          </Button>
        </div>
      )}
      {(error || checkoutError) && !connecting && (
        <div role="alert" className="mb-4 text-sm">
          {error || checkoutError}{" "}
          {error && (
            <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </Button>
          )}
        </div>
      )}
      {!data && !error && !connecting && (
        <div
          aria-label="Loading email service"
          className="h-36 animate-pulse rounded-xl bg-muted"
        />
      )}
      {data?.billingUnavailable && !connecting && (
        <p role="status" className="mb-4 text-sm">
          Email billing is temporarily unavailable.
        </p>
      )}
      {connecting ? (
        <ExistingMailConnection />
      ) : sending && senderPlan ? (
        <MailAdminPanel managed limits={capacity} sendingConfigured={data.sendingConfigured} onRefresh={markSendingConfigured}
          setup={{
            sendingOnly: true,
            mailboxes: existingMailHost
              ? <MailRedirect href={serviceHref(existingMailHost.id) + "&tab=mailboxes"} label={copy.openDashboard} />
              : <MailWelcomeCard title={copy.inboxOfferTitle} description={copy.inboxOfferDescription}>
                  <Button asChild className="mt-6">
                    <Link href={emailPlansHref(null, organizationId, "mailboxes")}>
                      {copy.viewMailboxPlans}<Icon name="arrow-right" className="rtl:rotate-180" />
                    </Link>
                  </Button>
                </MailWelcomeCard>,
          }} />
      ) : sending ? (
        <ManagedSending canAddDomain={!!data?.plan} configured={data?.sendingConfigured} allowance={capacity?.recipients}
          onConfigured={markSendingConfigured} />
      ) : access ? (
        <>
          <CloudMailAccess
            plansHref={billingHref}
            connectHref={href("connect")}
            pending={!!data?.pendingPlan}
          />
          {data?.sendingConfigured && (
            <Button asChild variant="link" className="mt-3">
              <Link href={href("sending")}>{copy.sendingActivity}</Link>
            </Button>
          )}
        </>
      ) : service?.provisioning && !data?.plan ? provisioning : service && !service.provisioning ? (
        <MailAdminPanel
          key={service.id}
          managed
          limits={capacity}
          sendingConfigured={data?.sendingConfigured}
          serverId={service.id}
          status={{
            active: false,
            steps: [],
            domain: service.hostname.replace(/^mail\./, ""),
            webmail: service.webmailUrl ? {
              installed: true,
              url: service.webmailUrl,
              hostname: new URL(service.webmailUrl).hostname,
            } : undefined,
          }}
          onRefresh={() => setAttempt((n) => n + 1)}
          onForgotten={() => setAttempt((n) => n + 1)}
        />
      ) : data && !service && requestedView === "dedicated" ? (
        <section className="space-y-4">
          <h2 className="text-lg font-medium">{copy.dedicatedTitle}</h2>
          {!data.billingUnavailable && <Button asChild>
            <Link href={emailPlansHref(null, organizationId, "dedicated")}>{copy.browsePlans}</Link>
          </Button>}
        </section>
      ) : (
        data && (
          <CloudMailSetup
            data={data}
            busy={busy}
            availabilityCheck={attempt !== finishedAttempt ? "checking" : finishedAttempt > 0 && !error ? "checked" : "idle"}
            onActivate={activate}
            onRetry={() => setAttempt(n => n + 1)}
            onDomainConnected={nextHref => {
              markSendingConfigured();
              go(nextHref);
            }}
            sendingHref={id => href("sending", id)}
            provisioning={provisioning}
          />
        )
      )}
    </PageContainer>
  );
}
