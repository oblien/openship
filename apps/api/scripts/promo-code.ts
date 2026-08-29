/**
 * Promo codes — the operator CLI, run inside the API container.
 *
 *   docker compose exec api bun --cwd apps/api scripts/promo-code.ts create --percent 20 --code LAUNCH20
 *   docker compose exec api bun --cwd apps/api scripts/promo-code.ts list
 *   docker compose exec api bun --cwd apps/api scripts/promo-code.ts show LAUNCH20
 *   docker compose exec api bun --cwd apps/api scripts/promo-code.ts revoke LAUNCH20
 *
 * Stripe is the source of truth: a code, how many times it has been redeemed and
 * when it expires all live on the Stripe coupon + promotion code, so there is no
 * Openship table to keep in sync and nothing to reconcile. Redemption needs no
 * new code either — checkout already sends `allow_promotion_codes: true`, so the
 * "Add promotion code" box is on the Stripe Checkout page.
 *
 * Imports are deliberately limited to `../src/lib/stripe-client` plus the
 * pricing catalog. Anything that reaches @repo/db would run a TOP-LEVEL
 * `createDb()` in this process — migrations, a 90s Postgres wait, and on PGlite
 * a single-instance lock the live API already holds.
 */

import type Stripe from "stripe";
import { PLAN_IDS, PRICING, resolveStripePriceId, type PlanTierId } from "@repo/core";
import { stripe } from "../src/lib/stripe-client";

const INVOCATION = "bun --cwd apps/api scripts/promo-code.ts";
/** Stamped on everything this CLI creates, so hand-made codes stay tellable. */
const CREATED_BY = "openship-promo-cli";

const out = (msg = "") => console.log(msg ? `[promo-code] ${msg}` : "");
const warn = (msg: string) => console.error(`[promo-code] ${msg}`);

function usage(msg: string): never {
  warn(msg);
  warn(`run \`${INVOCATION} --help\` for usage.`);
  process.exit(2);
}

/* ─── Arg parsing ─────────────────────────────────────────────────────────── */

interface Args {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 2) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const name = token.slice(2);
    if (!name) usage(`"${token}" is not a flag.`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }

  return { command: positionals[0] ?? "", positionals: positionals.slice(1), flags };
}

function rejectUnknownFlags(flags: Args["flags"], allowed: readonly string[]): void {
  for (const name of flags.keys()) {
    if (allowed.includes(name)) continue;
    usage(
      allowed.length === 0
        ? `unknown flag --${name} (this command takes no flags).`
        : `unknown flag --${name} (allowed: ${allowed.map((f) => `--${f}`).join(", ")}).`,
    );
  }
}

function strFlag(flags: Args["flags"], name: string): string | null {
  const value = flags.get(name);
  if (value === undefined) return null;
  if (value === true) usage(`--${name} needs a value.`);
  const trimmed = value.trim();
  if (!trimmed) usage(`--${name} needs a value.`);
  return trimmed;
}

function boolFlag(flags: Args["flags"], name: string): boolean {
  const value = flags.get(name);
  if (typeof value === "string") usage(`--${name} takes no value.`);
  return value === true;
}

function intFlag(flags: Args["flags"], name: string): number | null {
  const raw = strFlag(flags, name);
  if (raw === null) return null;
  if (!/^\d+$/.test(raw) || Number(raw) === 0) {
    usage(`--${name} must be a whole number greater than 0 (got "${raw}").`);
  }
  return Number(raw);
}

/**
 * `--expires 2026-09-01` means "redeemable through that day", so the timestamp
 * is the END of it (UTC) — otherwise the code dies the midnight before.
 */
function parseExpiry(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) usage(`--expires must be YYYY-MM-DD (got "${raw}").`);
  const ms = Date.parse(`${raw}T23:59:59Z`);
  if (Number.isNaN(ms)) usage(`--expires "${raw}" is not a real date.`);
  if (ms <= Date.now()) usage(`--expires "${raw}" is already in the past.`);
  return Math.floor(ms / 1000);
}

function parseTiers(raw: string | null): PlanTierId[] | null {
  if (raw === null) return null;
  const wanted = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (wanted.length === 0) usage("--plan needs at least one tier id.");

  const tiers: PlanTierId[] = [];
  for (const name of wanted) {
    const tier = PLAN_IDS.find((id) => id === name);
    if (!tier) usage(`--plan "${name}" is not a tier id (valid: ${PLAN_IDS.join(", ")}).`);
    if (!tiers.includes(tier)) tiers.push(tier);
  }
  return tiers;
}

/* ─── Catalog ─────────────────────────────────────────────────────────────── */

/** The env var the catalog names for a tier's monthly price; null = not purchasable. */
function priceEnvFor(tier: PlanTierId): string | null {
  return PRICING.plans.find((plan) => plan.id === tier)?.stripePriceEnv.monthly ?? null;
}

/** Tiers a code can be restricted to — the ones the catalog sells monthly. */
const RESTRICTABLE_TIERS: readonly PlanTierId[] = PLAN_IDS.filter((id) => priceEnvFor(id) !== null);

function resolvePriceIds(tiers: PlanTierId[]): { tier: PlanTierId; priceId: string }[] {
  return tiers.map((tier) => {
    const envName = priceEnvFor(tier);
    if (!envName) {
      usage(
        `--plan ${tier} is not a purchasable tier — the catalog configures no monthly Stripe price for it. ` +
          `Restrictable tiers: ${RESTRICTABLE_TIERS.join(", ")}.`,
      );
    }
    const priceId = resolveStripePriceId(tier, "monthly");
    if (!priceId) {
      warn(
        `--plan ${tier}: no Stripe price id in this container's environment. ` +
          `Set ${envName} and re-run — refusing to create an unrestricted code instead.`,
      );
      process.exit(1);
    }
    return { tier, priceId };
  });
}

/* ─── Stripe helpers ──────────────────────────────────────────────────────── */

/**
 * stripe-node's types are generated for a much newer API version than the one
 * `STRIPE_API_VERSION` pins, and the newer spec moved a promotion code's coupon
 * under `promotion.coupon`. The wire contract follows the pin, not the SDK, so
 * send/read the flat `coupon` field and accept either shape on the way back —
 * a future version bump then costs nothing here.
 */
function couponRefOf(promo: Stripe.PromotionCode): Stripe.Coupon | string | null {
  const raw = promo as unknown as {
    coupon?: Stripe.Coupon | string | null;
    promotion?: { coupon?: Stripe.Coupon | string | null };
  };
  return raw.coupon ?? raw.promotion?.coupon ?? null;
}

const couponCache = new Map<string, Stripe.Coupon>();

async function resolveCoupon(promo: Stripe.PromotionCode): Promise<Stripe.Coupon | null> {
  const ref = couponRefOf(promo);
  if (ref === null) return null;
  if (typeof ref !== "string") return ref;
  const cached = couponCache.get(ref);
  if (cached) return cached;
  const coupon = await stripe().coupons.retrieve(ref);
  couponCache.set(ref, coupon);
  return coupon;
}

function couponIdOf(promo: Stripe.PromotionCode): string | null {
  const ref = couponRefOf(promo);
  return ref === null ? null : typeof ref === "string" ? ref : ref.id;
}

/**
 * Stripe coupons restrict by PRODUCT, never by price, so a tier's configured
 * price id has to be mapped to its product first. Consequence worth knowing:
 * restricting to a tier covers every price on that product (a future annual
 * price included).
 */
async function productIdsFor(priced: { tier: PlanTierId; priceId: string }[]): Promise<string[]> {
  const products: string[] = [];
  for (const { tier, priceId } of priced) {
    let price: Stripe.Price;
    try {
      price = await stripe().prices.retrieve(priceId);
    } catch (err) {
      throw new Error(`could not read the Stripe price for ${tier} (${priceId}): ${describeError(err)}`);
    }
    const product = typeof price.product === "string" ? price.product : price.product.id;
    if (!products.includes(product)) products.push(product);
  }
  return products;
}

let productTiers: Map<string, PlanTierId> | null = null;

/** product id → tier id, for printing "plans: pro, team" instead of raw ids. */
async function tierByProduct(): Promise<Map<string, PlanTierId>> {
  if (productTiers) return productTiers;
  const map = new Map<string, PlanTierId>();
  for (const tier of RESTRICTABLE_TIERS) {
    const priceId = resolveStripePriceId(tier, "monthly");
    if (!priceId) continue;
    try {
      const price = await stripe().prices.retrieve(priceId);
      const product = typeof price.product === "string" ? price.product : price.product.id;
      map.set(product, tier);
    } catch {
      // A stale env price id must not break `list` — the raw product id prints.
    }
  }
  productTiers = map;
  return map;
}

async function findByCode(code: string): Promise<Stripe.PromotionCode | null> {
  // No `active` filter: revoked and expired codes must still be findable.
  const page = await stripe().promotionCodes.list({ code, limit: 2 });
  return page.data[0] ?? null;
}

function describeError(err: unknown): string {
  const e = err as { message?: string; type?: string; code?: string } | null;
  const message = e?.message ?? String(err);
  if (e?.code) return `${message} (code ${e.code})`;
  if (e?.type) return `${message} (${e.type})`;
  return message;
}

/* ─── Formatting ──────────────────────────────────────────────────────────── */

const CURRENCY = PRICING.currency.toUpperCase();

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: CURRENCY }).format(cents / 100);
}

function day(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function describeDiscount(coupon: Stripe.Coupon | null): string {
  if (!coupon) return "unknown discount";
  const amount =
    coupon.percent_off !== null
      ? `${coupon.percent_off}% off`
      : coupon.amount_off !== null
        ? `${money(coupon.amount_off)} off`
        : "no discount";
  const span =
    coupon.duration === "repeating"
      ? ` for ${coupon.duration_in_months} months`
      : coupon.duration === "once"
        ? " on the first invoice"
        : " forever";
  return amount + span;
}

async function describeScope(coupon: Stripe.Coupon | null): Promise<string> {
  const products = coupon?.applies_to?.products ?? [];
  if (products.length === 0) return "any plan";
  const tiers = await tierByProduct();
  return `plans: ${products.map((p) => tiers.get(p) ?? p).join(", ")}`;
}

function redemptions(promo: Stripe.PromotionCode): string {
  return `used ${promo.times_redeemed}/${promo.max_redemptions ?? "unlimited"}`;
}

function block(rows: [string, string][]): void {
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) out(`  ${label.padEnd(width)}  ${value}`);
}

/* ─── create ──────────────────────────────────────────────────────────────── */

const CREATE_FLAGS = [
  "percent",
  "amount",
  "code",
  "months",
  "once",
  "max-redemptions",
  "expires",
  "plan",
  "dry-run",
] as const;

async function cmdCreate({ flags }: Args): Promise<void> {
  rejectUnknownFlags(flags, CREATE_FLAGS);

  const percentRaw = strFlag(flags, "percent");
  const amountRaw = strFlag(flags, "amount");
  if (percentRaw !== null && amountRaw !== null) usage("--percent and --amount are mutually exclusive.");
  if (percentRaw === null && amountRaw === null) {
    usage(`one of --percent <1-100> or --amount <cents of ${CURRENCY}> is required.`);
  }

  let percentOff: number | null = null;
  if (percentRaw !== null) {
    const percent = Number(percentRaw);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      usage(
        `--percent must be greater than 0 and at most 100 (got "${percentRaw}"). ` +
          `For a fixed discount use --amount <cents>.`,
      );
    }
    if (Math.round(percent * 100) !== percent * 100) {
      usage(`--percent takes at most 2 decimal places (got "${percentRaw}").`);
    }
    percentOff = percent;
  }
  const amountOff = amountRaw === null ? null : intFlag(flags, "amount");

  const once = boolFlag(flags, "once");
  const months = intFlag(flags, "months");
  if (once && months !== null) usage("--once and --months are mutually exclusive.");
  const duration: Stripe.CouponCreateParams.Duration =
    months !== null ? "repeating" : once ? "once" : "forever";

  const code = strFlag(flags, "code")?.toUpperCase() ?? null;
  if (code !== null && !/^[A-Z0-9-]+$/.test(code)) {
    usage(`--code may only contain letters, digits and dashes (got "${code}").`);
  }

  const maxRedemptions = intFlag(flags, "max-redemptions");
  const expiresAt = parseExpiry(strFlag(flags, "expires"));
  const tiers = parseTiers(strFlag(flags, "plan"));
  const priced = tiers === null ? [] : resolvePriceIds(tiers);
  const dryRun = boolFlag(flags, "dry-run");

  const couponParams: Stripe.CouponCreateParams = {
    duration,
    ...(percentOff !== null ? { percent_off: percentOff } : { amount_off: amountOff!, currency: PRICING.currency }),
    ...(duration === "repeating" ? { duration_in_months: months! } : {}),
    ...(code ? { name: code } : {}),
    metadata: { created_by: CREATED_BY },
  };
  const promoParams = {
    ...(code ? { code } : {}),
    ...(expiresAt !== null ? { expires_at: expiresAt } : {}),
    ...(maxRedemptions !== null ? { max_redemptions: maxRedemptions } : {}),
    metadata: { created_by: CREATED_BY, ...(tiers ? { plans: tiers.join(",") } : {}) },
  };

  if (dryRun) {
    out("dry run — no Stripe calls made.");
    for (const { tier, priceId } of priced) {
      out(`stripe.prices.retrieve("${priceId}")   // ${tier} → the product id coupon.applies_to needs`);
    }
    const appliesTo = priced.length > 0 ? { applies_to: { products: priced.map((p) => `<product of ${p.priceId}>`) } } : {};
    out(`stripe.coupons.create(${JSON.stringify({ ...couponParams, ...appliesTo })})`);
    out(`stripe.promotionCodes.create(${JSON.stringify({ coupon: "<new coupon id>", ...promoParams })})`);
    return;
  }

  const products = await productIdsFor(priced);
  const coupon = await stripe().coupons.create({
    ...couponParams,
    ...(products.length > 0 ? { applies_to: { products } } : {}),
  });

  let promo: Stripe.PromotionCode;
  try {
    promo = await stripe().promotionCodes.create({
      coupon: coupon.id,
      ...promoParams,
    } as unknown as Stripe.PromotionCodeCreateParams);
  } catch (err) {
    // The coupon exists but is unreachable without a code — drop it so retrying
    // the same command doesn't leave a pile of orphans in the Stripe dashboard.
    await stripe()
      .coupons.del(coupon.id)
      .catch(() => {});
    throw err;
  }

  out(`created ${promo.code}`);
  block([
    ["discount", describeDiscount(coupon)],
    ["applies to", await describeScope(coupon)],
    ["redemptions", redemptions(promo)],
    ["expires", promo.expires_at ? day(promo.expires_at) : "never"],
    ["stripe", `coupon ${coupon.id} · promotion code ${promo.id}`],
    ["mode", promo.livemode ? "LIVE" : "test (this key is a test key)"],
  ]);
  out();
  out(
    `Hand out ${promo.code} — customers enter it in the "Add promotion code" box on the ` +
      `Stripe Checkout page (checkout already sends allow_promotion_codes: true).`,
  );
}

/* ─── list / show / revoke ────────────────────────────────────────────────── */

async function cmdList({ flags }: Args): Promise<void> {
  rejectUnknownFlags(flags, ["all"]);
  const all = boolFlag(flags, "all");

  const page = await stripe().promotionCodes.list({ limit: 100, ...(all ? {} : { active: true }) });
  if (page.data.length === 0) {
    out(all ? "no promotion codes exist." : "no active promotion codes (--all includes revoked and expired ones).");
    return;
  }

  const width = Math.max(...page.data.map((promo) => promo.code.length));
  for (const promo of page.data) {
    const coupon = await resolveCoupon(promo);
    const bits = [
      promo.code.padEnd(width),
      describeDiscount(coupon),
      redemptions(promo),
      promo.expires_at ? `expires ${day(promo.expires_at)}` : "no expiry",
      await describeScope(coupon),
    ];
    if (!promo.active) bits.push("INACTIVE");
    out(bits.join("  ·  "));
  }
  if (page.has_more) out(`… showing the newest ${page.data.length}; more exist in the Stripe dashboard.`);
}

async function cmdShow({ positionals, flags }: Args): Promise<void> {
  rejectUnknownFlags(flags, []);
  const code = positionals[0];
  if (!code) usage("show needs a code: `promo-code.ts show LAUNCH20`.");

  const promo = await findByCode(code);
  if (!promo) {
    warn(`no promotion code matches "${code}".`);
    process.exit(1);
  }
  const coupon = await resolveCoupon(promo);

  out(promo.code);
  block([
    ["status", promo.active ? "active" : "inactive (revoked, expired or exhausted)"],
    ["discount", describeDiscount(coupon)],
    ["applies to", await describeScope(coupon)],
    ["redemptions", redemptions(promo)],
    ["expires", promo.expires_at ? day(promo.expires_at) : "never"],
    ["created", day(promo.created)],
    ["first order only", promo.restrictions.first_time_transaction ? "yes" : "no"],
    [
      "minimum amount",
      promo.restrictions.minimum_amount === null
        ? "none"
        : `${promo.restrictions.minimum_amount} ${(promo.restrictions.minimum_amount_currency ?? PRICING.currency).toUpperCase()}`,
    ],
    ["stripe", `coupon ${couponIdOf(promo) ?? "unknown"} · promotion code ${promo.id}`],
    ["mode", promo.livemode ? "LIVE" : "test"],
  ]);
}

async function cmdRevoke({ positionals, flags }: Args): Promise<void> {
  rejectUnknownFlags(flags, []);
  const code = positionals[0];
  if (!code) usage("revoke needs a code: `promo-code.ts revoke LAUNCH20`.");

  const promo = await findByCode(code);
  if (!promo) {
    warn(`no promotion code matches "${code}".`);
    process.exit(1);
  }
  if (!promo.active) {
    out(`${promo.code} is already inactive — nothing to do.`);
    return;
  }

  await stripe().promotionCodes.update(promo.id, { active: false });
  out(`revoked ${promo.code} — it can no longer be redeemed.`);
  out(
    `The coupon (${couponIdOf(promo) ?? "unknown"}) is left in place: subscriptions that already ` +
      `redeemed the code keep their discount, and past invoices still reference it.`,
  );
}

/* ─── help ────────────────────────────────────────────────────────────────── */

function printHelp(): void {
  const restrictable = RESTRICTABLE_TIERS.map((tier) => `\n                           ${tier} → ${priceEnvFor(tier)}`).join("");
  console.log(`Openship promo codes — Stripe coupons + promotion codes, managed from the API container.

Usage
  ${INVOCATION} <command> [flags]
  docker compose exec api ${INVOCATION} <command> [flags]

Commands
  create                 Mint a coupon and a promotion code for it.
  list                   List promotion codes, newest first.
  show <code>            Everything Stripe knows about one code.
  revoke <code>          Deactivate a code. The coupon is kept — live subscriptions
                         and historical invoices still reference it.

create flags
  --percent <n>          Percent off; greater than 0, at most 100, up to 2 decimals.
                         Mutually exclusive with --amount; one of the two is required.
  --amount <cents>       Fixed amount off, in cents of ${CURRENCY} (--amount 1000 = ${money(1000)}).
  --code <CODE>          The customer-facing code, upper-cased. Letters, digits and
                         dashes only. Omit it and Stripe generates one (it gets printed).
  --months <n>           The discount repeats for n billing months.
  --once                 The discount applies to the first invoice only.
                         Neither flag => the discount lasts forever. --months and --once
                         are mutually exclusive.
  --max-redemptions <n>  Total redemptions allowed across all customers. Default unlimited.
  --expires <YYYY-MM-DD> Last day the code can be redeemed (end of that day, UTC).
                         Default never.
  --plan <ids>           Restrict the discount to these tiers, comma-separated
                         (e.g. --plan pro,team). Each named tier's Stripe price id must
                         be configured or the command refuses:${restrictable}
  --dry-run              Print the exact Stripe calls this would make, then exit.
                         Needs no Stripe credentials.

list flags
  --all                  Include inactive codes (revoked, expired, exhausted).

Environment
  STRIPE_SECRET_KEY      Required by every command except --dry-run. Whether it is a
                         test or live key decides which mode the code lands in — the
                         output says which.

Exit codes
  0 success · 1 Stripe or configuration error · 2 usage error`);
}

/* ─── main ────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    process.exit(0);
  }
  if (argv.length === 0) {
    printHelp();
    process.exit(2);
  }

  const args = parseArgs(argv);
  if (!args.command) usage("no command given (expected create, list, show or revoke).");

  try {
    switch (args.command) {
      case "create":
        await cmdCreate(args);
        break;
      case "list":
        await cmdList(args);
        break;
      case "show":
        await cmdShow(args);
        break;
      case "revoke":
        await cmdRevoke(args);
        break;
      default:
        usage(`unknown command "${args.command}" (expected create, list, show or revoke).`);
    }
  } catch (err) {
    warn(`failed: ${describeError(err)}`);
    process.exit(1);
  }
  process.exit(0);
}

void main();
