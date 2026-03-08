import { docs, blog } from "@/.source/server";
import { loader } from "fumadocs-core/source";

export const docsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

export const blogSource = loader({
  baseUrl: "/blog",
  source: blog.toFumadocsSource(),
});
