---
name: gemini-image
description: Generate or edit images with Google Gemini image models (Nano Banana 2 / Pro) and send them to the chat. Use when the user asks for an image, a creative, an ad variant, a mockup, an infographic, or an edit of an uploaded picture.
---

# Gemini image generation

Generate images via the Gemini Interactions API with plain `curl`. Auth is
transparent: the gateway injects the `x-goog-api-key` header, you never set
or see a key. If a call returns 401/403, the Gemini key is not connected;
tell the operator, never ask for a raw key.

## Models (July 2026 lineup - use ONLY these)

| Model id | Nickname | Use for |
|---|---|---|
| `gemini-3.1-flash-image` | Nano Banana 2 | DEFAULT. Generalist: 4K, reliable text rendering, up to 10 object + 4 character reference images, Google Search grounding |
| `gemini-3-pro-image` | Nano Banana Pro | Premium: hardest prompts, brand consistency, style references, interleaved text+image output |
| `gemini-3.1-flash-lite-image` | Nano Banana 2 Lite | Bulk/cheap variants, 1K only, no search grounding |

Do not use `gemini-2.5-flash-image` (legacy, deprecated by Google).

## Text-to-image (the quick recipe)

```bash
mkdir -p /workspace/agent/images
curl -s -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.1-flash-image",
    "input": [{"type": "text", "text": "YOUR PROMPT"}],
    "response_format": {"type": "image", "mime_type": "image/png", "aspect_ratio": "1:1", "image_size": "1K"}
  }' > /tmp/gen.json

jq -r '[.steps[] | select(.type=="model_output") | .content[] | select(.type=="image") | .data] | last' /tmp/gen.json \
  | base64 -d > /workspace/agent/images/out.png
```

Then send with `mcp__nanoclaw__send_file({ file_path: "/workspace/agent/images/out.png", caption: "..." })`.

If the jq path returns empty, inspect `/tmp/gen.json` for an `error` object
or a text-only refusal before retrying.

Options:
- `aspect_ratio`: `1:1`, `3:2`, `2:3`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`. Ads: `1:1` or `4:5` feed, `9:16` stories/reels.
- `image_size`: `1K` (default, fine for chat), `2K`, `4K`. Uppercase K required.
- `generation_config: {"thinking_level": "high"}` for complex compositions (3.1 Flash Image; default is minimal).

## Image editing (image + text in)

Base64-encode the source image into the input array:

```bash
B64=$(base64 -w0 source.jpg)
curl -s -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"gemini-3.1-flash-image\",
    \"input\": [
      {\"type\": \"text\", \"text\": \"EDIT INSTRUCTION\"},
      {\"type\": \"image\", \"mime_type\": \"image/jpeg\", \"data\": \"$B64\"}
    ]
  }" > /tmp/gen.json
```

Up to 10 object reference images and 4 character references on the default
model. For strict brand/style matching (logo placement, style refs), switch
to `gemini-3-pro-image`.

## Iterating (multi-turn)

Each response JSON has an `id`. To refine the previous image, pass
`"previous_interaction_id": "<id>"` with the new instruction instead of
re-describing everything. This is the recommended way to iterate on a
creative with the user.

## Real-data images (grounded)

Add `"tools": [{"type": "google_search"}]` to generate imagery from live
facts (weather cards, event posters, market snapshots). Add
`"search_types": ["web_search", "image_search"]` inside the tool object for
visual grounding too. Not available on the lite model.

## Ad-creative tips

- Always state the text that must appear on the image verbatim, in quotes,
  and its language; these models render text reliably when told exactly.
- Describe the product, audience, and mood, not camera jargon.
- Generate 2-3 variants with different angles rather than one "perfect" ask;
  use the lite model for cheap variant sweeps, then upscale the winner on
  the default model at 2K.

## Cost note

This is a metered Google API, separate from the Claude subscription. A 1K
image on the default model costs cents; 4K and Pro cost more, and thinking
tokens bill by default. Generate deliberately, not speculatively.
