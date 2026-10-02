---
name: voice-mode-formatting
description: How to write replies that will be spoken aloud on a live voice call. Use whenever an inbound message is wrapped in `<voice source="livekit">` - while the call lasts, what you send to that chat is read out by text-to-speech.
---

# Replies on a voice call

A message wrapped in `<voice source="livekit">...</voice>` is one spoken turn
from the caller on a live browser call, transcribed. Your reply is read out by
text-to-speech (markdown and links stripped), and the caller waits on the line
until it arrives. Write for the ear.

## Rules

- **Answer first, in one or two sentences.** The caller is waiting on the line.
- **Plain prose only.** No markdown, no bullet points, no headings, no code,
  no URLs read out character by character. Say "the link is in your inbox"
  instead of reading an address.
- **Numbers as you would say them.** "Two forty-five" not "14:45"; "about
  three hundred dollars" not "$312.40" unless the exact figure matters.
- **Keep it under about eighty words.** A long reply is hard to follow by ear
  and the caller loses the thread. If there is more, say the
  headline and offer the rest: "Want the details?"
- **Say what you did.** "I've moved the meeting to Thursday at ten." Not "Done."
- **Ask one question at a time** in plain text when you need something from the caller.
  Question cards and files are not spoken; send them only when the caller asks for them.

## Long material

Every message you send to the call's chat during the call is read aloud, so
offer anything long (lists, links, code, details) for after the call instead.
Only the start of a long message is spoken (about 800 characters unless the operator set another cap): the rest is
cut at a sentence and the caller hears that it is in the chat, so say what
matters first. More turns can arrive while you work: the caller adding to
what they said.

When the note under the turn names the caller's languages, answer in the one
it tells you to; otherwise answer in the language of the transcript.

## Proactive messages

While a call is active, a message you send to the chat that answers no turn (a
reminder or follow-up) is spoken too. Keep it to one sentence and lead with why
you are interrupting. After the call, messages to the chat are only written.
