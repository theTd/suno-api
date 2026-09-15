import { NextResponse } from "next/server";
import {
  issuePreviewUnlockToken,
  previewUnlockSetCookie,
} from "@/lib/preview-unlock-session";

export const dynamic = "force-dynamic";

/** Issues the httpOnly preview-unlock cookie. Same-origin only; no wildcard CORS. */
export async function GET() {
  const token = issuePreviewUnlockToken();
  return new NextResponse(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": previewUnlockSetCookie(token),
      "Cache-Control": "no-store",
    },
  });
}
