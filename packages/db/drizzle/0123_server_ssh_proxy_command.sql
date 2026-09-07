-- OpenSSH ProxyCommand used to reach servers behind Cloudflare Access or another
-- custom SSH transport. The value is passed to the system ssh client as one
-- `-o ProxyCommand=...` option and is not interpreted by the API shell.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "ssh_proxy_command" text;
