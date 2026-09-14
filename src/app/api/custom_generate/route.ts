import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers';
import { DEFAULT_MODEL, rewriteForbiddenAudioUrls, sunoApi } from "@/lib/SunoApi";
import { parseGenerationExtras } from "@/lib/generation-options";
import { corsHeaders } from "@/lib/utils";
import { ClientGoneError } from "@/lib/captcha-gate";

export const maxDuration = 60; // allow longer timeout for wait_audio == true
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const { prompt, tags, title, make_instrumental, model, wait_audio, negative_tags } = body;

      if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
        return new NextResponse(JSON.stringify({ error: 'Prompt is required' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      let extras;
      try {
        extras = parseGenerationExtras(body);
      } catch (e: any) {
        return new NextResponse(JSON.stringify({ error: e.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const audioInfo = await (await sunoApi((await cookies()).toString())).custom_generate(
        prompt, tags, title,
        Boolean(make_instrumental),
        model || DEFAULT_MODEL,
        Boolean(wait_audio),
        negative_tags,
        req.signal,
        extras
      );
      return new NextResponse(JSON.stringify(rewriteForbiddenAudioUrls(audioInfo, req.nextUrl.origin)), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error: any) {
      console.error('Error generating custom audio:', error);
      if (error instanceof ClientGoneError)
        console.log('Client gone; dropped request: ' + error.message);
      return new NextResponse(JSON.stringify({ error: error.response?.data?.detail || error.toString() }), {
        status: error.response?.status || 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: {
        Allow: 'POST',
        ...corsHeaders
      },
      status: 405
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
