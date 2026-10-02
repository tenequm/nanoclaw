---
name: voice-formatting
description: How to write replies that will be spoken aloud on a live voice call through the voice channel. Use whenever the inbound message came from the voice channel (sender handle starts with `voice:`, or the text is wrapped in `<voice source="livekit">`) — the reply is read out by text-to-speech, not displayed.
---

# Replies on a voice call

A message wrapped in `<voice source="livekit">…</voice>` is one spoken turn
from the caller on a live browser call, transcribed. Your reply is read out by
text-to-speech (markdown and links stripped), and the caller waits on the line
until it arrives. Write for the ear.

## Rules

- **Lead with the answer.** The caller is waiting on the line: say the
  conclusion first, then what supports it.
- **Plain prose only.** No markdown, no bullet points, no headings, no code,
  no URLs read out character by character. Say "the link is in your inbox"
  instead of reading an address.
- **Numbers as you would say them.** "Two forty-five" not "14:45"; "about
  three hundred dollars" not "$312.40" unless the exact figure matters.
- **Match the depth to the question.** Brief for a simple one. For design,
  strategy or anything that needs care, take the time to think and verify,
  then give the full considered answer in plain speech. Make a long answer easy
  to follow by ear: say how many points there are, then take them one at a
  time.
- **Say what you did.** "I've moved the meeting to Thursday at ten." Not "Done."
- **Ask one question at a time** in plain text when you need something from the caller.
  This channel cannot deliver interactive question cards or file attachments.
  Send files through another wired destination.

## Long material

Where anything long (lists, links, code, details) goes depends on the note
under the turn. A call on the voice line itself: put it in a separate written
message to your chat, and say so in one spoken sentence. A call that talks in
a chat: every message you send to that chat during the call is read aloud, so
offer it for after the call instead. A message is spoken in full unless the
operator set a length cap; with one, the rest is cut at a sentence and the
caller hears that it is in the chat, so say what matters first. More turns can
arrive while you work: the caller adding to what they said.

The caller speaks Ukrainian or English: a transcript that looks Russian is
Ukrainian misspelled by speech recognition, so answer in Ukrainian (in English
if the caller spoke English), never in Russian.

## Names the transcription gets wrong

When a transcript misspells a name or term you know (a person, project,
product or place), add the correct spelling to
`/workspace/agent/voice.vocabulary.txt`, one term per line. The
transcription spells it exactly from the next call. A call takes at most 60
terms and 1 KB, counting any the operator set, and drops the rest: replace
stale or rarely used entries to stay within it, and never add common words.

## Proactive messages

While a call is active, a message you send that answers no turn (a reminder
or follow-up) is spoken too. Keep it to one sentence and lead with why you are
interrupting. After hangup, delivery fails; use another wired destination for
a message that must reach the person while they are offline.
