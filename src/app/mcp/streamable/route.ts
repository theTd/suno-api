import { NextRequest } from "next/server";
import {
  handleMcpRequest,
  handleMcpDelete,
  mcpOptionsHandler,
} from "@/lib/mcp-streamable-handler";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleMcpRequest(req);
}

export async function GET(req: NextRequest) {
  return handleMcpRequest(req);
}

export async function DELETE(req: NextRequest) {
  return handleMcpDelete(req);
}

export async function OPTIONS() {
  return mcpOptionsHandler();
}
