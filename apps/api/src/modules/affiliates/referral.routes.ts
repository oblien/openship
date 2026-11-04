import { Hono } from "hono";
import { readAffiliateOffer } from "@repo/platform/engine/modules/affiliates/affiliate-public";
import { secureRouter } from "../../lib/secure-router";

export const referralRoutes = new Hono();
const r = secureRouter(referralRoutes, { module: "referrals", basePath: "/api/referrals" });
r.public(
  "get",
  "/:code",
  {
    reason:
      "Public commercial referral terms for signup and checkout; contains no account or earnings data.",
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ data: await readAffiliateOffer(c.req.param("code") ?? "") });
  },
);
