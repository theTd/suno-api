import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sunoApi } from "@/lib/SunoApi";
import { isClipId } from "@/lib/clip-id";
import { grantUnlockConsent, hasUnlockConsent } from "@/lib/unlock-consent";
import { clipReadyToUnlock } from "@/lib/preview-unlock-flags";
import {
  PREVIEW_UNLOCK_COOKIE,
  isPreviewPageUnlockRequest,
} from "@/lib/preview-unlock-session";

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

function unlockRequestFrom(req: NextRequest) {
  return {
    cookie: req.cookies.get(PREVIEW_UNLOCK_COOKIE)?.value,
    origin: req.headers.get("origin"),
    host: req.headers.get("x-forwarded-host") || req.headers.get("host"),
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const clipId = params.id;
  if (!isClipId(clipId)) {
    return json({ error: "Invalid clip id" }, 400);
  }
  if (!isPreviewPageUnlockRequest(unlockRequestFrom(req))) {
    return json({ error: "Preview page session required" }, 403);
  }
  return json({ id: clipId, unlocked: hasUnlockConsent(clipId) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const clipId = params.id;
  if (!isClipId(clipId)) {
    return json({ error: "Invalid clip id" }, 400);
  }
  if (!isPreviewPageUnlockRequest(unlockRequestFrom(req))) {
    return json({ error: "Unlock is only allowed from the preview page" }, 403);
  }

  try {
    const cookie = (await cookies()).toString();
    const api = await sunoApi(cookie);
    const clips = await api.get([clipId]);
    const status = clips[0]?.status;
    if (!clipReadyToUnlock(status)) {
      return json(
        { error: "Clip is not ready to unlock", status: status ?? null },
        409
      );
    }
    grantUnlockConsent(clipId);
    return json({ id: clipId, unlocked: true });
  } catch (error: any) {
    return json(
      { error: error?.message || "Failed to record unlock consent" },
      502
    );
  }
}
