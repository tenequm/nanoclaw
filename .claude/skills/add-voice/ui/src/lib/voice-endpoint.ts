/**
 * Resolve the host's routes from the page URL, preserving proxy prefixes. The page sits at the
 * voice root (/voice, the walkie) or one segment below it (/voice/call, /webhook/voice/call,
 * /webhook/voice/livekit), with or without a trailing slash; the routes live under that root.
 */
export function voiceEndpoint(route: "info" | "sdp" | "hangup" | "livekit/token" | "livekit/end", token: string, pageUrl = location.href): URL {
  const url = new URL(pageUrl)
  // Set the pathname rather than resolve a string, so a path like //other.example/call keeps the origin.
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/(?:call|livekit)$/, "")}/${route}`
  url.search = ""
  url.hash = ""
  url.searchParams.set("t", token)
  return url
}
