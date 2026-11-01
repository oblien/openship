ALTER TABLE "cluster_network" ADD COLUMN "source" jsonb;
--> statement-breakpoint
-- Preserve routed and mixed-provider networks as Custom. Provider identity alone
-- does not establish that attachments belong to the same provider network.
UPDATE "cluster_network" AS network
SET "source" = (
  SELECT CASE
    WHEN count(DISTINCT attachment.provider_id) = 1
      AND count(DISTINCT coalesce(nullif(btrim(attachment.network_ref), ''), '')) = 1
    THEN jsonb_strip_nulls(jsonb_build_object(
      'providerId', min(attachment.provider_id),
      'networkRef', nullif(min(btrim(attachment.network_ref)), '')
    ))
    ELSE jsonb_build_object('providerId', 'custom')
  END
  FROM "server_network_attachment" AS attachment
  WHERE attachment.network_id = network.id
)
WHERE network.mode = 'native';
