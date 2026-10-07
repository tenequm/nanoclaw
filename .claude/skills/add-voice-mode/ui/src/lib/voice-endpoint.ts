import { CLIENT_PROTOCOL_VERSION } from "./voice-call"

/**
 * Resolve the host's routes from the page URL, preserving proxy prefixes. The page sits at the
 * voice root (/voice) or at a legacy address one segment below it (/voice/livekit,
 * /webhook/voice/livekit), with or without a trailing slash; the routes live under that root.
 */
export function voiceEndpoint(route: "info" | "livekit/token" | "livekit/end", token: string, pageUrl = location.href): URL {
  const url = new URL(pageUrl)
  // Set the pathname rather than resolve a string, so a path like //other.example/livekit keeps the origin.
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/livekit$/, "")}/${route}`
  url.search = ""
  url.hash = ""
  url.searchParams.set("t", token)
  url.searchParams.set("v", String(CLIENT_PROTOCOL_VERSION))
  return url
}
