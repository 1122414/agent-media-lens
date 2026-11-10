# Verify the final container as its runtime user

A dependency PR changed the Node builder to 26. CI built the image but the final container exited 127: its copied Node binary needed libatomic.so.1, which the Python-based final stage did not contain. Install libatomic1 in the final image; testing the builder alone cannot detect this.

The Python 3.15 base is separate from the 3.12 ASR worker: the project lock targets 3.12 and locked onnxruntime 1.31.1 offers no CPython 3.15 wheel. When uv supplies an interpreter for the worker, keep it in a shared directory rather than a build user's private home. Check the image as the configured non-root user with `docker compose run --rm lens doctor --platform xiaohongshu`; this exercises the media libraries without a network provider.

Verified on the local arm64 image: Node 26.13.0 starts, the non-root user (UID 10001) imports faster-whisper 1.2.1, and the Python 3.12.13 worker decodes a two-second generated clip to a JPEG.

Evidence: [failed Node 26 container job](https://github.com/1122414/agent-media-lens/actions/runs/42557548491/job/128966533251), [image recipe](../../../Dockerfile) and [CI](../../../.github/workflows/ci.yml). This diagnosis applies to this multi-stage image and locked worker, not to all Node or Python applications.

A healthy Docker engine does not imply that the `docker compose` subcommand exists. On Homebrew with Colima, the engine responded but only the standalone modern `docker-compose` binary worked. From a clean source tree (no host node_modules, dist or .venv), the host launcher detected that binary, built the image, passed the local OCR/ASR check, and an SDK client connected to its stdio launcher and listed 13 tools at version 0.5.0. This verifies the container and launcher on that host, not guest availability. CI exercises the other Compose invocation. [Installer](../../../media-lens).
