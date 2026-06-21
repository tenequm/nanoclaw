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
send_file({ path: "<printed absolute path>", text: "(optional caption)" })
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
you can mix them. Two rules from Google's docs:

- **Audio tags stay in English even when the speech isn't.** Write Ukrainian
  text with English tags. Example:
  `--text "[привітно] Привіт! [laughs] Я щойно навчився говорити."`
  (the `[laughs]` tag is English, the spoken words are Ukrainian).
- **Accents come from a style instruction, not the language.** To shape an
  accent, describe it (see below) rather than relying on the language code.

## Audio tags (expressive control)

Tags are inline `[square-bracket]` cues that steer delivery. The model reads
the *meaning* of your text, so tags fine-tune emotion, pace, and non-verbal
sounds. Google's formula:

> `[pacing tag]` spoken text `[expressive tag]` spoken text `[pause tag]` spoken text

**Rules (important — follow exactly):**
- Tags are **English only**; the spoken text can be any language.
- Put a tag **exactly** where the change should happen.
- **Always separate tags with text or punctuation — never place two tags
  back-to-back** (`[slow][whispers]` errors; `[slow] well… [whispers]` is fine).

**Common tags:**
- *Emotion:* `[excited]`, `[happy]`, `[serious]`, `[sad]`, `[nervous]`,
  `[curious]`, `[sarcastic]`, `[angry]`, `[hopeful]`, `[amused]`
- *Non-verbal:* `[laughs]`, `[sighs]`, `[gasp]`, `[whispers]`, `[shouting]`,
  `[giggles]`, `[cough]`
- *Pacing:* `[slow]`, `[fast]`, `[short pause]`, `[long pause]`

The list isn't exhaustive — descriptive tags work too (`[reluctantly]`,
`[like telling a secret]`). Example:
`--text "[excited] We did it! [laughs] [short pause] I honestly can't believe it worked."`

## Voice matching

Pick a `--voice` whose character reinforces the mood, and keep it consistent
for a persona. A few of the 30: `Alnilam` (firm — the default), `Puck` (upbeat),
`Aoede` (breezy), `Enceladus` (breathy — good for tired/intimate), `Achird`
(friendly), `Sulafat` (warm), `Charon` (informative). The voice and the text's
tone should agree — don't push a deep firm voice to sound like a giddy child.

## Optional: richer direction

For a more crafted performance you can prepend a short natural-language style
note, e.g. `--text "Say warmly and slowly: бережи себе сьогодні."` or describe
style/pacing/accent in a sentence before the line.

**Safety rule when you do this:** the model can occasionally *read your
directions aloud* if it can't tell instruction from script. So when you add a
style preamble, make the spoken part unambiguous — phrase it as
`Read this aloud: "<the exact words>"`. For a plain voice note with inline tags
only (the common case), no preamble is needed.

## Notes

- This is a **metered Google API** (separate from the Claude subscription) —
  roughly $0.018 per minute of audio. Cheap, but don't generate long speech
  casually; prefer short voice notes.
- Output is OGG/Opus, 24 kHz mono — correct for Telegram voice. All audio is
  SynthID-watermarked by Google.
- If the call fails with a 401/403, the Gemini key isn't connected — tell the
  user to add it in OneCLI; do not ask them for a raw key.
