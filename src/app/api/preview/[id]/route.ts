import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ClipAudioNotReadyError, sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const CLIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const clipId = params.id;
  if (!CLIP_ID.test(clipId)) {
    return NextResponse.json({ error: 'Invalid clip id' }, { status: 400, headers: corsHeaders });
  }

  try {
    const cookie = (await cookies()).toString();
    const { buffer, contentType } = await (await sunoApi(cookie)).getPreviewAudio(clipId);
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
        'Content-Disposition': `inline; filename="${clipId}-preview.${ext}"`,
        'Cache-Control': 'private, max-age=60',
        ...corsHeaders
      }
    });
  } catch (error: any) {
    console.error('Error capturing preview audio:', error?.message || error);
    if (error instanceof ClipAudioNotReadyError) {
      return NextResponse.json(
        { error: error.message },
        { status: 409, headers: { ...corsHeaders, 'Retry-After': '5' } }
      );
    }
    return NextResponse.json(
      { error: error?.message || 'Failed to capture preview audio' },
      { status: 502, headers: corsHeaders }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
