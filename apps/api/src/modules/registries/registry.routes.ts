import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./registry.controller";
import { CreateContainerRegistryBody, UpdateContainerRegistryBody } from "./registry.schema";

const r = secureRouter(new Hono(), { module: "registries", basePath: "/api/registries" });

r.get("/", { tag: "settings:read" }, ctrl.list);
r.post("/", { tag: "settings:admin", collection: true, body: CreateContainerRegistryBody }, ctrl.create);
r.patch("/:id", { tag: "settings:admin", body: UpdateContainerRegistryBody }, ctrl.update);
r.post("/:id/test", { tag: "settings:admin" }, ctrl.test);
r.delete("/:id", { tag: "settings:admin" }, ctrl.remove);

export const containerRegistryRoutes = r.hono;
