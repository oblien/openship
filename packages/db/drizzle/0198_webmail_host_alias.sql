-- Older managed webmail installs predate the saved Docker host alias. Their
-- mail hostname can resolve to host loopback, which is the webmail container's
-- own loopback after recreation. Match the managed installer's host-gateway
-- mapping only for its linked webmail service on the mail server itself.
--
-- Retain explicit aliases and all other configuration. No runtime is changed
-- here: updated_at makes the normal deployment planner apply the saved repair
-- on the next deploy. Remote/Cloud and external webmail have no local binding.
UPDATE "service" AS s
SET "advanced" = jsonb_set(
      COALESCE(NULLIF(s."advanced", 'null'::jsonb), '{}'::jsonb),
      '{extraHosts}',
      COALESCE(NULLIF(s."advanced"->'extraHosts', 'null'::jsonb), '{}'::jsonb)
        || jsonb_build_object('mail.' || m."domain", 'host-gateway')
    ),
    "updated_at" = now()
FROM "mail_servers" AS m
JOIN "project" AS p ON p."id" = m."webmail_project_id"
JOIN "servers" AS host ON host."id" = m."server_id"
  AND host."organization_id" = p."organization_id"
WHERE s."project_id" = p."id"
  AND s."name" = 'webmail'
  AND p."app_template_id" = 'webmail'
  AND p."server_id" = m."server_id"
  AND host."workspace_id" IS NULL
  AND p."deleted_at" IS NULL
  AND NOT COALESCE(p."deletion_in_progress", false)
  AND jsonb_typeof(COALESCE(NULLIF(s."advanced", 'null'::jsonb), '{}'::jsonb)) = 'object'
  AND COALESCE(jsonb_typeof(s."advanced"->'extraHosts'), 'null') IN ('object', 'null')
  -- Match DNS names case-insensitively and keep the installer's existing
  -- 100-alias validation limit rather than making a valid map undeployable.
  AND (SELECT count(*) FROM jsonb_object_keys(
    CASE WHEN jsonb_typeof(s."advanced"->'extraHosts') = 'object'
      THEN s."advanced"->'extraHosts' ELSE '{}'::jsonb END
  )) < 100
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_object_keys(
      CASE WHEN jsonb_typeof(s."advanced"->'extraHosts') = 'object'
        THEN s."advanced"->'extraHosts' ELSE '{}'::jsonb END
    ) AS alias(hostname)
    WHERE lower(alias.hostname) = lower('mail.' || m."domain")
  );
