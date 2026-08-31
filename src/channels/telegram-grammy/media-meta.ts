/**
 * Probe media buffers for the metadata Telegram needs to render the
 * right preview / player UX:
 *
 *   - video / animation: width + height + duration (without dims, portrait
 *     clips render as a square placeholder)
 *   - audio / voice: duration (without it, the player shows "0:00" until
 *     the client finishes downloading + parsing the file itself)
 *
 * Pure-JS via mediabunny — no ffprobe binary, no apt deps. Returns null
 * on any failure so the caller can fall through to the metadata-less
 * send (delivery still succeeds, just without the UX polish).
 */
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';

export interface MediaMeta {
  /** Present only for files with a video track. */
  width?: number;
  /** Present only for files with a video track. */
  height?: number;
  duration: number;
}

export async function probeMediaMeta(data: Buffer): Promise<MediaMeta | null> {
  // Node Buffers can share an underlying ArrayBuffer with siblings (pool
  // reuse for <8KB allocations). Slice to the logical view so mediabunny
  // doesn't read past the file.
  const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const input = new Input({ source: new BufferSource(view), formats: ALL_FORMATS });
  try {
    const duration = await input.computeDuration();
    if (!Number.isFinite(duration)) return null;
    const roundedDuration = Math.max(0, Math.round(duration));

    const track = await input.getPrimaryVideoTrack();
    if (track) {
      const width = track.displayWidth;
      const height = track.displayHeight;
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return {
          width: Math.round(width),
          height: Math.round(height),
          duration: roundedDuration,
        };
      }
    }
    // No video track and no positive duration → mediabunny opened the
    // file but found nothing usable (typical for truncated/garbage
    // input that happens to start with a valid container magic).
    if (roundedDuration <= 0) return null;
    return { duration: roundedDuration };
  } catch {
    return null;
  }
}
