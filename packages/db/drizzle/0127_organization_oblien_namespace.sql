-- A namespace is a tenant boundary. Never silently adopt an existing duplicate:
-- conflicting historical rows need explicit migration before this can apply.
ALTER TABLE "organization" ADD CONSTRAINT "organization_oblien_namespace_unique" UNIQUE ("oblien_namespace");
