## Chat with your model backend

Open WebUI is a chat frontend for Ollama and OpenAI-compatible APIs. This template runs the official slim image, keeps accounts/chats/settings in a persistent volume, and creates an administrator with a generated password. Public sign-up is disabled.

Choose the administrator email before the first deployment, then sign in using the Connection card. Later account changes belong in Open WebUI: changing the initial bootstrap email or password does not reset an existing account.

## Connect a provider

Choose an existing Ollama installation during setup, or configure Ollama/an OpenAI-compatible API in **Admin Settings → Connections** after sign-in. The template does not deploy Ollama or vLLM, download a model, or provide an inference subscription. A working chat needs a reachable backend and a suitable model.

The frontend itself requests no GPU. Embedding and document features use the configured backend rather than an automatically downloaded local embedding model. Keep authentication enabled and the generated session secret stable across restarts. The upstream Open WebUI branding is preserved.

This template is self-hosted only. Back up the persistent data volume before upgrades.

[Official setup](https://docs.openwebui.com/getting-started/quick-start/) · [Administrator bootstrap](https://docs.openwebui.com/features/authentication-access/rbac/roles/)
