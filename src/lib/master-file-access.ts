import { isClipId } from "./clip-id";
import { hasUnlockConsent } from "./unlock-consent";

export function masterFileAccessDenied(
  clipId: string
): { status: number; error: string } | null {
  if (!isClipId(clipId)) return { status: 400, error: "Invalid clip id" };
  if (!hasUnlockConsent(clipId)) {
    return { status: 403, error: "Clip has not been unlocked on /mcp/preview" };
  }
  return null;
}
