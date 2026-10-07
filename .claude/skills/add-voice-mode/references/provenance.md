# Voice mode provenance

This contribution started from glifocat's [voice adapter draft](https://github.com/nanocoai/nanoclaw/pull/3764) and [voice skill and UI draft](https://github.com/nanocoai/nanoclaw/pull/3772). The browser component starting point includes [ElevenLabs UI](https://github.com/elevenlabs/ui) and [shadcn/ui](https://github.com/shadcn-ui/ui). Their complete MIT notices accompany the generated page.

The subsequent implementation adds a dedicated Gemini Live transcription pipeline, acoustic wake, automatic and reviewed turns, explicit send/discard commands, captions, reply cues, typing audio, reconnect grace and per-line limits. It remains a separate `voice-mode` channel, worker, namespace and install skill.

## Browser distribution

The page is generated from the [browser source](../ui/package.json) into `src/channels/voice-mode-page.ts`. To change it, run `pnpm install --frozen-lockfile --ignore-scripts`, then `pnpm run build` in `ui/`; the generated source-hash test covers the page and its notices.

The self-contained page embeds complete third-party notices in a readable disclosure. `src/channels/voice-mode-third-party-notices.txt` carries the same notices in the installed payload. The UI source hash includes the notices, full font licenses, generator and every browser source/build input. The [notice source](../ui/THIRD_PARTY_NOTICES.md) contains bundled JavaScript licenses and font copyright/OFL texts. [Hanken Grotesk](https://github.com/google/fonts/tree/main/ofl/hankengrotesk) and [IBM Plex Mono](https://github.com/google/fonts/tree/main/ofl/ibmplexmono) retain their full OFL-1.1 licenses beside the WOFF2 files. The NanoClaw logo comes from the project's MIT-licensed browser draft.

## Acoustic assets

All three ONNX models and both WAV fixtures are unmodified from [livekit-wakeword revision fb92cb3](https://github.com/livekit/livekit-wakeword/tree/fb92cb3), version 0.2, Apache-2.0, Copyright 2026 LiveKit, Inc. The accompanying LICENSE and NOTICE ship with them.

- `melspectrogram.onnx`: `src/livekit/wakeword/resources/melspectrogram.onnx`, the openWakeWord/torchlibrosa mel front end.
- `embedding_model.onnx`: `src/livekit/wakeword/resources/embedding_model.onnx`, derived from [Google speech_embedding/1](https://www.kaggle.com/models/google/speech-embedding/tensorFlow1/speech-embedding/1), Apache-2.0.
- `hey_livekit.onnx`: `examples/resources/hey_livekit.onnx`, LiveKit's classifier for "hey livekit". This is not an openWakeWord pretrained classifier.
- `positive.wav` and `negative.wav`: the source repository's `tests/fixtures/`, not operator recordings.

The inference implementation is a TypeScript port of the upstream inference pipeline. Custom operator classifiers remain runtime data outside the contribution and are not distributed.

| Distributed file | SHA-256 |
| --- | --- |
| `assets/voice-mode-wakeword/embedding_model.onnx` | `70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f` |
| `assets/voice-mode-wakeword/hey_livekit.onnx` | `8bd634fb7acf1e52d06307fb8f460abf2c7a40e561fb4532fc56e087e0246f62` |
| `assets/voice-mode-wakeword/melspectrogram.onnx` | `ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f` |
| `src/channels/voice-mode-wakeword-fixtures/negative.wav` | `ec90c9abd2c357d3fce2b7a1e6ea3d58e78893a45d951369b08992ea3e37144d` |
| `src/channels/voice-mode-wakeword-fixtures/positive.wav` | `99e4988d368c3c4749a7ac904f36d546860e813374292e8a9e28e9d994cc9521` |
