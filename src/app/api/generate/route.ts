import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers'
import { DEFAULT_MODEL, rewriteForbiddenAudioUrls, sunoApi } from "@/lib/SunoApi";
import { parseGenerationExtras } from "@/lib/generation-options";
import { corsHeaders } from "@/lib/utils";
import { ClientGoneError } from "@/lib/captcha-gate";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const { prompt, make_instrumental, model, wait_audio } = body;

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

      const audioInfo = await (await sunoApi((await cookies()).toString())).generate(
        prompt,
        Boolean(make_instrumental),
        model || DEFAULT_MODEL,
        Boolean(wait_audio),
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
      console.error('Error generating audio:', error);

      // Client disconnected while queued/in flight; nothing meaningful to respond to
      if (error instanceof ClientGoneError) {
        console.log('Client gone; dropped request: ' + error.message);
        return new NextResponse(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // Handle different types of errors
      if (error.response) {
        // Axios error with response
        console.error('Response error:', JSON.stringify(error.response.data));
        
        if (error.response.status === 402) {
          return new NextResponse(JSON.stringify({ 
            error: error.response.data?.detail || 'Payment required' 
          }), {
            status: 402,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
        return new NextResponse(JSON.stringify({ 
          error: 'API Error: ' + (error.response.data?.detail || error.response.statusText || 'Unknown error')
        }), {
          status: error.response.status || 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } else if (error.request) {
        // Axios error without response (network error, timeout, etc.)
        console.error('Network error:', error.message);
        return new NextResponse(JSON.stringify({ 
          error: 'Network error: Unable to connect to Suno API. Please check your internet connection and try again.' 
        }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } else {
        // Other types of errors (timeout, etc.)
        console.error('Other error:', error.message);
        return new NextResponse(JSON.stringify({ 
          error: 'Internal error: ' + (error.message || 'Unknown error occurred') 
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
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