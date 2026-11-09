# Development setup

Follow the source installation commands in [README](../../README.md). Use one private cache per operator. The Node and Python environments are pinned independently by pnpm-lock.yaml and uv.lock. The development checkout is the installation root for both launchers; keep it in place after linking.

To isolate settings, write a local JSON file with cacheDir, model and ocrLang, and set MEDIA_LENS_CONFIG to its absolute path. No secret belongs in this file. A provider key is needed only for live resolution and download. Run [the offline suite](testing.md) first and configure the [provider](../providers/douyin.md) separately.
