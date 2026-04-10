# Media Download

Download media from URLs and send to chats using yt-dlp and instaloader.

## Sending Downloaded Media

All downloaded files go under `/workspace/group/` (use `/workspace/group/tmp/` for throwaway files).

- **Single file** - use `send_file`. Photos (.jpg, .png, .gif, .webp) display inline, videos (.mp4, .mov) play with streaming, everything else is sent as a document.
- **Multiple files** - use `send_media_group` (2-10 items). Photos and videos display as a gallery album.

## yt-dlp

General-purpose video downloader. Works with YouTube, Instagram reels, Twitter/X, TikTok, and hundreds of other sites.

```bash
yt-dlp "<URL>" -o /workspace/group/tmp/<filename>.mp4
```

For Instagram reels/video - always use format '1' (native H.264 mp4), NOT DASH:

```bash
yt-dlp -f 1 "<URL>" -o /workspace/group/tmp/<filename>.mp4
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
cd /workspace/group/tmp && instaloader -- -<SHORTCODE>
# Files are saved to folder ./-<SHORTCODE>/
```

Send carousels as an album with `send_media_group`, single videos with `send_file`.

### Note

"instagram-saver" (Cobalt V7 API) is dead - shut down November 2024, do not use.
