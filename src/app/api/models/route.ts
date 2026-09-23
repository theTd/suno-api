import { NextResponse } from "next/server";
import { DEFAULT_MODEL, listSunoModels } from "@/lib/suno-models";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET() {
  return new NextResponse(JSON.stringify({
    default_model: DEFAULT_MODEL,
    models: listSunoModels(),
    note: 'Model ids are the `mv` / `model` values accepted by the generate endpoints. `default_model` is the id used when no `model` is passed; `default_for` only records which /create tab the official client preselects. Custom model ids minted via "Create Custom Model (Beta)" on suno.com are also accepted but are per-account and not listed here.'
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
