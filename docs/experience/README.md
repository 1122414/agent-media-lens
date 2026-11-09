# Engineering experience

[Passing decoded audio into ASR](patterns/asr-pcm.md) applies when FFmpeg succeeds but transcription fails opening the WAV. Verified with English and Mandarin clips on the same locked stack.

[Separating API readiness, guest capacity and video access](patterns/provider-readiness.md) applies when health checks pass but real Douyin resolution fails. Verified once on a live v5 deployment; error transport and capacity boundaries are regression-tested offline.
