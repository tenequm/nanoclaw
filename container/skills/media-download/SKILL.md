# Media Download

Download media from URLs using yt-dlp and instaloader.

## Video Downloads (yt-dlp + Instagram)

### yt-dlp - General Usage

For Instagram reels/video - always use format '1' (native H.264 mp4), NOT DASH:

```bash
yt-dlp -f 1 "<URL>" -o ~/Downloads/videos/<filename>.mp4
```

- Format '1' = H.264, embedded audio, correct SAR, no muxing needed
- DASH formats (dash-v + dash-a) = VP9, require muxing with ffmpeg, and mess up aspect ratio on mobile
- After download, send via curl to Telegram Bot API with 'width' and 'height' parameters

### Instagram - Choosing the Right Tool

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
instaloader -- -<SHORTCODE>
# Files are saved to folder ./-<SHORTCODE>/
```

Send carousels via `sendMediaGroup` (album), video via `sendVideo`.

### Note

"instagram-saver" (Cobalt V7 API) is dead - shut down November 2024, do not use.
