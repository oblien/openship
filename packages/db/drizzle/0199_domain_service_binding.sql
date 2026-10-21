-- A domain row can own its service binding (POST/PATCH /api/domains with
-- serviceId + targetPort) instead of mirroring the service's publicEndpoints.
-- Existing rows keep today's behavior: every binding was derived from the list.
ALTER TABLE "domain" ADD COLUMN "bound_by_domain" boolean DEFAULT false NOT NULL;
