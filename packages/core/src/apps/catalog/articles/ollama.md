## Run models on your server

Ollama provides a model API and stores downloads in a persistent volume. Choose CPU mode or one NVIDIA GPU during installation. GPU mode requires a compatible host driver and NVIDIA Container Toolkit; Openship does not install either or reserve GPU memory.

The model API stays private because Ollama does not authenticate requests. Use **Open in localhost** for a local client or **Use in a project** to connect another application. The template does not expose the API on a public domain.

## Download a model

Open the service Terminal and run `ollama pull qwen3:0.6b`. Then use `ollama run qwen3:0.6b` or call the API. The template does not download a large model automatically or block deployment on that download. Check Logs while a model is loading; API readiness and model availability are different states.

Sizing depends on the model, context length and concurrent requests. The catalog's CPU/RAM guidance is a starting point, not a guarantee that every model fits. Models persist across container replacement; back up the volume if you need to preserve custom models.

This template is self-hosted only. CPU mode works without GPU access; the GPU request path is tested, but this template's GPU inference has not been independently tested on physical hardware.

[Official Docker setup](https://docs.ollama.com/docker) · [Model library](https://ollama.com/library)
