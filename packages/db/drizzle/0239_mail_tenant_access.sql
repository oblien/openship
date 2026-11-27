CREATE TABLE mail_tenant_access (
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  namespace text NOT NULL,
  service_id text NOT NULL UNIQUE,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  parent_id text REFERENCES personal_access_token(id) ON DELETE SET NULL,
  token_hash text NOT NULL UNIQUE,
  PRIMARY KEY (server_id, namespace)
);
