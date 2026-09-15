import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { Readable } from 'stream';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

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
    const api = await sunoApi(cookie);

    // ?stream=1: progressive chunked response — audio bytes flow while the
    // in-browser capture is still running, so an unfinished track can be
    // previewed before the harvest completes.
    const wantStream = req.nextUrl.searchParams.get('stream');
    if (wantStream === '1' || wantStream === 'true') {
      const { stream, contentType } = await api.openPreviewStream(clipId, req.signal);
      const webStream = Readable.toWeb(stream) as ReadableStream;
      return new Response(webStream, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `inline; filename="${clipId}-preview"`,
          // A live capture is a linear stream: it cannot serve arbitrary byte
          // ranges, so tell the player not to attempt range-based seeking.
          'Accept-Ranges': 'none',
          // Never buffer/transform a stream that is still growing.
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
          ...corsHeaders
        }
      });
    }

    // Already captured: stream the binary straight away.
    const cached = await api.getCachedPreview(clipId);
    if (cached) {
      const ext = cached.contentType.includes('webm')
        ? 'webm'
        : cached.contentType.includes('wav')
          ? 'wav'
          : cached.contentType.includes('mp4')
            ? 'm4a'
            : 'mp3';
      const total = cached.buffer.length;

      // Range support: media elements seek by re-requesting byte ranges.
      const range = req.headers.get('range');
      const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range.trim()) : null;
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
        if (start >= total) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${total}`, ...corsHeaders }
          });
        }
        const slice = cached.buffer.subarray(start, end + 1);
        return new NextResponse(Uint8Array.from(slice), {
          status: 206,
          headers: {
            'Content-Type': cached.contentType,
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Disposition': `inline; filename="${clipId}-preview.${ext}"`,
            'Cache-Control': 'private, max-age=60',
            ...corsHeaders
          }
        });
      }

      return new NextResponse(Uint8Array.from(cached.buffer), {
        status: 200,
        headers: {
          'Content-Type': cached.contentType,
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
          'Content-Disposition': `inline; filename="${clipId}-preview.${ext}"`,
          'Cache-Control': 'private, max-age=60',
          ...corsHeaders
        }
      });
    }

    // Not captured yet: report status only. Probing must NOT start the
    // harvest — a capture is only triggered by an actual listen request
    // (?stream=1 from the preview deck). A harvest started elsewhere
    // (e.g. a running stream) is still reported live here.
    const status = api.previewJobStatus(clipId);
    if (status?.state === 'error') {
      return NextResponse.json(
        { id: clipId, ...status, retry_after: 30 },
        { status: 502, headers: { ...corsHeaders, 'Retry-After': '30' } }
      );
    }
    return NextResponse.json(
      { id: clipId, state: 'idle', ...status, retry_after: 5 },
      { status: 202, headers: { ...corsHeaders, 'Retry-After': '5' } }
    );
  } catch (error: any) {
    console.error('Error starting preview capture:', error?.message || error);
    return NextResponse.json(
      { error: error?.message || 'Failed to start preview capture' },
      { status: 502, headers: corsHeaders }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
