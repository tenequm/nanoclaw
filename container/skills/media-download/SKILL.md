---
name: media-download
description: >-
  Download media from URLs with yt-dlp or instaloader and send the resulting
  files to chats.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Media Download

Download media from URLs and send to chats using yt-dlp and instaloader.

## Sending Downloaded Media

All downloaded files go under `/workspace/agent/` (use `/workspace/agent/tmp/` for throwaway files).

- **Single file** - use `send_file({ to, path, text? })`. Photos (.jpg, .png, .gif, .webp) display inline, videos (.mp4, .mov) play with streaming, everything else is sent as a document.
- **Multiple files** - use `send_media_group({ to, items })` (2-10 items). Photos and videos display as a gallery album; each item is `{ path, caption? }`.

Both require an explicit `to` destination. There is no reply-in-place shortcut, even when the group has only one destination. `list_destinations` shows the options.

## yt-dlp

General-purpose video downloader. Works with YouTube, Instagram reels, Twitter/X, TikTok, and hundreds of other sites.

```bash
yt-dlp "<URL>" -o /workspace/agent/tmp/<filename>.mp4
```

For Instagram reels/video - always use format '1' (native H.264 mp4), NOT DASH:

```bash
yt-dlp -f 1 "<URL>" -o /workspace/agent/tmp/<filename>.mp4
```

- Format '1' = H.264, embedded audio, correct SAR, no muxing needed
- DASH formats (dash-v + dash-a) = VP9, require muxing with ffmpeg, and mess up aspect ratio on mobile

## Instagram

### Choosing the Right Tool

| Situation                            | Tool                                |
|--------------------------------------|-------------------------------------|
| Reel / single video                  | `yt-dlp -f 1 "<URL>"`              |
| yt-dlp returns 0 items              | `instaloader -- -<SHORTCODE>`       |
| or format unavailable                |                                     |
| Carousel (multiple photos/videos)    | `instaloader -- -<SHORTCODE>`       |

### How to Get SHORTCODE

From URL: `instagram.com/p/DWs_UtSCG5z/` -> shortcode = `DWs_UtSCG5z`

### Carousel Downloads with instaloader

```bash
cd /workspace/agent/tmp && instaloader -- -<SHORTCODE>
# Files are saved to folder ./-<SHORTCODE>/
```

Send carousels as an album with `send_media_group`, single videos with `send_file`.

### Note

"instagram-saver" (Cobalt V7 API) is dead - shut down November 2024, do not use.
