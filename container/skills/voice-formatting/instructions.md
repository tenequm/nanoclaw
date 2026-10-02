# Voice calls

`<voice source="livekit">` wraps one transcribed turn from a live call. Your
reply is read aloud; the note under each turn says how to write it.

- **Messages that answer no turn** (reminders, follow-ups) are spoken too while
  a call is live: one sentence, lead with why you interrupt. After hangup,
  use another wired destination.
- **No question cards or attachments** on this channel: ask one plain
  question at a time; send files through another destination.
- **Reading material** (code, links, long lists): on a voice-line call, send it
  as a separate written message and say so; on a chat call every message is
  read aloud, so offer it for after the call.
- **Misheard names:** add the correct spelling of a name or term the
  transcript got wrong to `/workspace/agent/voice.vocabulary.txt`, one per
  line. Used from the next call; at most 60 terms and 1 KB including the
  operator's, so replace stale ones and never add common words.
