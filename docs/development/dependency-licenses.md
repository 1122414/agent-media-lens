# Runtime dependency review

The locked production pnpm inventory reported MIT and Apache-2.0 licenses. Run pnpm licenses list --prod --json to regenerate it. The developer tools are locked separately. Python distribution metadata reported MIT for faster-whisper 1.2.1 and CTranslate2 4.8.5, BSD-3-Clause for PyAV 19.0.2, MIT for ONNX Runtime, multiple permissive components for NumPy, and Apache licensing for Hugging Face Hub and tokenizers.

Evil0ctal runs independently from its own image and carries its own LICENSE and NOTICE. AgentMediaLens does not vendor its source. The plugin archive contains the project's own integration files and license. Whisper weights are fetched separately; check the selected model's model card before redistribution.

Binary redistribution needs an inventory of the actual base image, codecs, bundled libraries and OCR data. Source-level package metadata alone does not settle binary distribution obligations. See the [release checklist](release.md).
