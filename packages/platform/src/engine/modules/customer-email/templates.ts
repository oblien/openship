import { SUPPORT_EMAIL } from "@repo/core";
import type { CustomerPaymentEmail } from "@repo/db/repos";

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const button = (url: string, label: string) =>
  `<p style="margin:28px 0"><a href="${escape(url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600">${label}</a></p>`;
const layout = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#202020"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:auto;background:white;border-radius:16px"><tr><td style="padding:36px;font-size:15px;line-height:1.65"><p style="margin:0 0 30px;font-weight:650">OpenShip</p><h1 style="font-size:25px;line-height:1.25;margin:0 0 24px">${title}</h1>${body}<p style="margin:32px 0 0;padding-top:20px;border-top:1px solid #eee;color:#777;font-size:12px">OpenShip · <a href="mailto:${SUPPORT_EMAIL}" style="color:inherit">${SUPPORT_EMAIL}</a></p></td></tr></table></td></tr></table></body></html>`;
const hello = (name: string) => `Hi ${name.trim() || "there"},`;
const help =
  "If you need a hand with setup, deployments, or billing, just reply to this email. We're here to help.";

export function signupWelcome(name: string, workspaceUrl: string, plansUrl: string) {
  return {
    subject: "Welcome to OpenShip",
    text: `${hello(name)}\n\nWelcome to OpenShip. Your workspace is ready. Connect a server, deploy your first app, and keep everything in one place.\n\nOpen your workspace: ${workspaceUrl}\n\nIf you'd like a managed place to deploy, you can explore OpenShip Cloud whenever you're ready: ${plansUrl}\n\n${help}\n\nThe OpenShip team`,
    html: layout(
      "Welcome to OpenShip",
      `<p>${escape(hello(name))}</p><p>Your workspace is ready. Connect a server, deploy your first app, and keep everything in one place.</p>${button(workspaceUrl, "Open your workspace")}<p>If you'd like a managed place to deploy, you can <a href="${escape(plansUrl)}" style="color:#333">explore OpenShip Cloud</a> whenever you're ready.</p><p>${help}</p><p>The OpenShip team</p>`,
    ),
  };
}

export function purchaseWelcome(name: string, payment: CustomerPaymentEmail, workspaceUrl: string) {
  return {
    subject: "Welcome aboard — your OpenShip purchase is confirmed",
    text: `${hello(name)}\n\nThanks for choosing ${payment.productName}. Your payment is confirmed.\n\nOpen your workspace to check setup and take the next step: ${workspaceUrl}\n\n${help}\n\nYour invoice or receipt arrives in a separate email.\n\nThe OpenShip team`,
    html: layout(
      "Thanks for choosing OpenShip",
      `<p>${escape(hello(name))}</p><p>Your payment for <strong>${escape(payment.productName)}</strong> is confirmed.</p><p>Open your workspace to check setup and take the next step.</p>${button(workspaceUrl, "Open your workspace")}<p>${help}</p><p style="color:#777;font-size:13px">Your invoice or receipt arrives in a separate email.</p><p>The OpenShip team</p>`,
    ),
  };
}

export function invoiceEmail(name: string, payment: CustomerPaymentEmail, billingUrl: string) {
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: payment.currency,
  }).format(payment.amountCents / 100);
  const document = payment.paymentId.startsWith("in_") ? "invoice" : "receipt";
  return {
    subject: `Your OpenShip ${document} — ${amount}`,
    text: `${hello(name)}\n\nYour ${amount} payment for ${payment.productName} is confirmed.\n\nPayment reference: ${payment.paymentId}\n\nView and download your ${document} through Payments & invoices: ${billingUrl}\n\nFor billing help, contact ${SUPPORT_EMAIL}.\n\nOpenShip Billing`,
    html: layout(
      `Your payment is confirmed`,
      `<p>${escape(hello(name))}</p><p>We've received your payment for ${escape(payment.productName)}.</p><p style="font-size:28px;font-weight:650;margin:24px 0">${amount}</p><p style="color:#777;font-size:13px;overflow-wrap:anywhere">Payment reference: ${escape(payment.paymentId)}</p>${button(billingUrl, `View ${document}`)}<p>You can open and download the ${document} through Payments &amp; invoices.</p><p style="font-size:13px;color:#777">For billing help, contact <a href="mailto:${SUPPORT_EMAIL}" style="color:inherit">${SUPPORT_EMAIL}</a>.</p>`,
    ),
  };
}
