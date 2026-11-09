# Releasing v0.1.0

Verify both CI jobs on the intended main commit. Repeat the live public video, denied access, plugin installation, image and Markdown checks in [testing](testing.md). Review dependency licenses and shipping artifacts. FFmpeg licensing depends on the build configuration; preserve notices and source obligations when distributing compiled images. The project currently ships source and a Docker build recipe. [FFmpeg licensing](https://ffmpeg.org/legal.html)

Record the measured results and limitations in docs/releases/v0.1.0.md. Set matching versions in the package, Python project, MCP server and plugin manifest, update the lockfiles and changelog, then rerun checks. The tag workflow verifies the plugin version and successful CI before attaching the plugin archive to the GitHub Release. Keep a release untagged while a required acceptance check remains open.

Package the tagged marketplace descriptor and plugin with git archive. This preserves their relative paths for marketplace installation and excludes host filesystem metadata. Verify the six regular files, including the Apache license, and check the published asset digest after upload.
