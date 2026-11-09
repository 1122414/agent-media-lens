# Pass decoded PCM into faster-whisper

On Python 3.12, faster-whisper 1.2.1 passed metadata_errors to PyAV 19.0.2, which rejected that keyword. Both English and Mandarin clips failed after successful audio extraction. The silent-clip integration test did not enter the decoder.

The worker already produces mono, little-endian 16-bit PCM at 16 kHz. Read those samples with wave, normalize to float32, and pass the waveform into WhisperModel.transcribe. This preserves the media timeline and avoids a redundant decode. Verify by iterating segments on a voiced clip and checking both text and timestamps. Confirmed on two generated clips with CPU base. CUDA has not been verified. See workers/media_worker.py and tests/test_worker.py.
