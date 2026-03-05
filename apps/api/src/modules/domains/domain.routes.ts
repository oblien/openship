import { Hono } from "hono";
import * as domainController from "./domain.controller";

export const domainRoutes = new Hono();

domainRoutes.get("/", domainController.list);
domainRoutes.post("/", domainController.add);
domainRoutes.delete("/:id", domainController.remove);
domainRoutes.post("/:id/verify", domainController.verify);
