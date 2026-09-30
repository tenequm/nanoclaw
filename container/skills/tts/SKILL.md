---
name: tts
description: >-
  Speak: turn text into a voice note and send it as a Telegram voice bubble.
  Use this when the user asks you to "say", "speak", "read aloud", "send a
  voice message / voice note / voice reply", or when a spoken reply is clearly
  better than text (a short greeting, a poem, something emotional, an
  accessibility need). Uses Google Gemini TTS. Stay text by default — only
  speak when asked or when voice genuinely improves the moment.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Text-to-Speech (voice notes)

Generate a spoken voice note from text and deliver it as a native Telegram
voice message. You produce the audio file with the script below, then send it
with the `send_file` MCP tool — the host routes `.ogg` to `sendVoice`
automatically, so it shows up as a real voice bubble (with waveform + play).

## When to speak vs. write

- **Speak** when the user explicitly asks (say / speak / read aloud / voice
  message), or when a spoken reply is clearly the better experience.
- **Write** for everything else. Voice is a deliberate choice, not the default.
  Don't narrate long technical answers as audio unless asked.

## How to generate + send

The credential is handled by the OneCLI gateway — you never set an API key.

```bash
# Short text inline:
bun /app/skills/tts/scripts/tts.ts --text "Hey! On my way, fifteen minutes." --out voice.ogg

# Longer text via stdin (avoids quoting issues):
echo "Once upon a time, in a quiet harbor town…" | bun /app/skills/tts/scripts/tts.ts --out story.ogg
```

The script prints the absolute path of the finished `.ogg` on success. Pass
that exact path to `send_file`:

```
send_file({ to: "<destination>", path: "<printed absolute path>", text: "(optional caption)" })
```

Use the printed path rather than a bare filename so it resolves no matter the
working directory. Send it with no `text` for a pure voice note, or add a
short caption.

## Options

- `--voice <name>` — default `Alnilam` (firm, masculine). Other voices include `Puck`,
  `Charon`, `Aoede`, `Leda`, `Fenrir`, `Zephyr` (30 total). Pick one that fits
  the persona and keep it consistent.
- `--model <id>` — default `gemini-3.1-flash-tts-preview` (latest, most
  expressive). Don't change unless you have a reason.
- `--out <file>` — output filename (default `voice.ogg`). Must end in `.ogg`
  for a Telegram voice bubble; other audio extensions are sent as music files.

## Languages (Ukrainian, English, 70+ more)

The model auto-detects the language from your text — **just write in the target
language**. Ukrainian (`uk`) and English (`en`) are both fully supported, and
you can mix them.

## Plain text only

Pass exactly the words to be spoken, nothing else. The model picks up emotion,
intonation, pacing and accent from the meaning of the text by itself, and does
it better unassisted.

- **No audio tags** — no `[square-bracket]` cues of any kind (emotion, laughs,
  pauses, pacing). They make the result worse.
- **No style preambles or directions** — no "Say warmly:", "Read this aloud:",
  or descriptions of tone, pace or accent. The model may read them aloud.
- Shape the delivery through the words themselves: natural punctuation and
  phrasing are enough.

## Voice matching

Pick a `--voice` whose character fits the persona, and keep it consistent.
A few of the 30: `Alnilam` (firm — the default), `Puck` (upbeat),
`Aoede` (breezy), `Enceladus` (breathy), `Achird` (friendly), `Sulafat`
(warm), `Charon` (informative).

## Notes

- This is a **metered Google API** (separate from the Claude subscription) —
  roughly $0.018 per minute of audio. Cheap, but don't generate long speech
  casually; prefer short voice notes.
- Output is OGG/Opus, 24 kHz mono — correct for Telegram voice. All audio is
  SynthID-watermarked by Google.
- If the call fails with a 401/403, the Gemini key isn't connected — tell the
  user to add it in OneCLI; do not ask them for a raw key.
