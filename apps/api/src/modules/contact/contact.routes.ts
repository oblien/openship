import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./contact.controller";

const r = secureRouter(new Hono(), {
  module: "contact",
  basePath: "/api/contact",
});

r.public(
  "post",
  "/",
  { reason: "Contact form submission — no auth required" },
  ctrl.submit,
);

export const contactRoutes = r.hono;
