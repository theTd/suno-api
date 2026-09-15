/** Canonical Suno clip UUID. */
export const CLIP_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isClipId(value: string): boolean {
  return CLIP_ID_RE.test(value);
}
