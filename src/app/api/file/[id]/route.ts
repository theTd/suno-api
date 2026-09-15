import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ClipAudioNotReadyError, sunoApi } from '@/lib/SunoApi';
import { masterFileAccessDenied } from '@/lib/master-file-access';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const clipId = params.id;
  const denied = masterFileAccessDenied(clipId);
  if (denied) {
    return NextResponse.json({ error: denied.error }, { status: denied.status, headers: corsHeaders });
  }

  try {
    const cookie = (await cookies()).toString();
    const { buffer, contentType } = await (await sunoApi(cookie)).getPlayableAudio(clipId);
    const ext = contentType.includes('webm')
      ? 'webm'
      : contentType.includes('wav')
        ? 'wav'
        : contentType.includes('mp4')
          ? 'm4a'
          : 'mp3';
    return new NextResponse(Uint8Array.from(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(buffer.length),
        'Content-Disposition': `inline; filename="${clipId}.${ext}"`,
        'Cache-Control': 'private, max-age=86400',
        ...corsHeaders
      }
    });
  } catch (error: any) {
    console.error('Error fetching playable audio:', error?.message || error);
    if (error instanceof ClipAudioNotReadyError) {
      return NextResponse.json(
        { error: error.message },
        { status: 409, headers: { ...corsHeaders, 'Retry-After': '5' } }
      );
    }
    return NextResponse.json(
      { error: error?.message || 'Failed to harvest playable audio' },
      { status: 502, headers: corsHeaders }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
