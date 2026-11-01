/**
 * Pinned github.com SSH host keys, for SSH-protocol clones (server-key /
 * deploy-key auth). Written to a per-clone known_hosts file and used with
 * `StrictHostKeyChecking=yes` so the clone never trust-on-first-use (TOFU) —
 * a MITM on the server's network can't substitute a host key.
 *
 * Source: GitHub's published keys (https://api.github.com/meta → `ssh_keys`,
 * and https://docs.github.com/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).
 * GitHub rotates these rarely; if they do, refresh this constant (operators can
 * override via the future `GITHUB_KNOWN_HOSTS` env hook).
 */
export const GITHUB_KNOWN_HOSTS = [
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4nkGY7hyaXpVEX1FIv/Ofhmr+kJoxYtEDzHKmJcQuFhBLIWZhoP8HZBBAEHtmZ8fVdMj7oQg1kAdI6esaOc7dtCcTF+ux2r7Wg=",
].join("\n") + "\n";
