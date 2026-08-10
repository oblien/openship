ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "forward_git_to_server" boolean DEFAULT false NOT NULL;
