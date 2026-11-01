## NVIDIA inference preview

This template uses vLLM's official CUDA image, one NVIDIA GPU and a generated API key for its OpenAI-compatible API. It is listed as a preview and cannot be installed yet: real NVIDIA hardware validation is still required. It is self-hosted only and does not support managed Cloud or CPU-only servers.

The server needs a compatible NVIDIA driver and NVIDIA Container Toolkit. The selected model must fit the GPU's VRAM; ordinary RAM guidance does not measure VRAM or reserve GPU capacity. Openship does not provision GPUs or install drivers.

## Model and startup

The initial model is `Qwen/Qwen3-0.6B`. Choose a different Hugging Face model and, when required, provide a token and accept its license on Hugging Face. The first start downloads and loads the model. Check Logs for progress; a starting health check is not proof of a failed deployment.

The template persists model downloads and compilation caches. It gives the container a private 2 GiB `/dev/shm`, without sharing the host IPC namespace or enabling privileged mode. Context length, model choice and concurrency determine memory demand.

Use the generated API key as a bearer token for `/v1` requests. Keep that key private. The pinned image's CUDA version must be compatible with the host driver; this preview is not a guarantee for every NVIDIA card or model.

[Official Docker deployment](https://docs.vllm.ai/en/stable/deployment/docker/) · [GPU requirements](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/)
