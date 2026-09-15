/**
 * Public origin for MCP resource_link / rewritten preview URLs.
 * Prefer SUNO_PUBLIC_BASE_URL; otherwise derive from the incoming request.
 */
export function publicOriginFromEnv(): string {
  return (process.env.SUNO_PUBLIC_BASE_URL || "").replace(/\/$/, "");
}

export function publicOriginFromRequest(req: {
  headers: Headers;
  nextUrl?: { origin: string };
}): string {
  const env = publicOriginFromEnv();
  if (env) return env;
  const xfHost = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (xfHost) {
    const xfProto = req.headers.get("x-forwarded-proto");
    const proto =
      xfProto ||
      (req.nextUrl?.origin.startsWith("https://") ? "https" : "http");
    return `${proto}://${xfHost}`.replace(/\/$/, "");
  }
  return (req.nextUrl?.origin || "").replace(/\/$/, "");
}
