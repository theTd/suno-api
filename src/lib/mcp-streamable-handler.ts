import { NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, sessionCookieStore } from "@/lib/mcp-server-2025";
import { InMemoryEventStore } from "@/lib/inMemoryEventStore";
import { buildCorsHeaders } from "@/lib/utils";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { randomUUID } from "node:crypto";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ─── Shared State ────────────────────────────────────────────────────

export const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

// ─── Constants ───────────────────────────────────────────────────────

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-03-26"];

// ─── Helpers ─────────────────────────────────────────────────────────

function isInitializeRequest(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as any).jsonrpc === "2.0" &&
    (body as any).method === "initialize"
  );
}

function jsonRpcError(code: number, message: string, status: number, req?: NextRequest): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "Content-Type": "application/json", ...buildCorsHeaders(req) } }
  );
}

function parseMediaTypes(accept: string): string[] {
  return accept.split(",").map((m) => m.trim().split(";")[0].trim());
}

function mediaTypeMatches(accepted: string[], target: string): boolean {
  if (accepted.includes(target)) return true;
  if (accepted.includes("*/*")) return true;
  const [type] = target.split("/");
  if (type && accepted.includes(`${type}/*`)) return true;
  return false;
}

function validateAccept(req: NextRequest, isPost: boolean): Response | null {
  const accept = req.headers.get("accept") ?? "";
  const mediaTypes = parseMediaTypes(accept);
  const hasJson = mediaTypeMatches(mediaTypes, "application/json");
  const hasSse = mediaTypeMatches(mediaTypes, "text/event-stream");

  if (isPost) {
    if (!hasJson || !hasSse) {
      return jsonRpcError(
        -32002,
        "Bad Request: Accept header must include application/json and text/event-stream",
        400,
        req
      );
    }
  } else if (req.method === "GET") {
    if (!hasSse) {
      return jsonRpcError(
        -32002,
        "Bad Request: Accept header must include text/event-stream",
        400,
        req
      );
    }
  }
  return null;
}

function validateProtocolVersion(req: NextRequest): Response | null {
  const version = req.headers.get("mcp-protocol-version");
  if (!version) {
    // Backwards compatibility: assume 2025-03-26 when absent
    return null;
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return jsonRpcError(-32003, `Bad Request: Unsupported MCP-Protocol-Version: ${version}`, 400, req);
  }
  return null;
}

// ─── Main Request Handler ────────────────────────────────────────────

export async function handleMcpRequest(req: NextRequest): Promise<Response> {
  const isPost = req.method === "POST";

  // 1. Validate Accept header
  const acceptErr = validateAccept(req, isPost);
  if (acceptErr) return acceptErr;

  const sessionId = req.headers.get("mcp-session-id");
  const cookieStr = req.headers.get("cookie") ?? "";

  let transport: WebStandardStreamableHTTPServerTransport;
  let parsedBody: unknown;
  // Transport only needs headers when parsedBody is provided; build a fresh
  // lightweight Request to avoid body-lock issues with the consumed NextRequest.
  let requestForTransport: Request = req;

  // Only parse body for POST requests
  if (isPost) {
    try {
      parsedBody = await req.json();
    } catch (err) {
      logger.warn({ err, url: req.url }, "Failed to parse MCP request body as JSON");
      parsedBody = undefined;
    }
    requestForTransport = new Request(req.url, {
      method: req.method,
      headers: req.headers,
    });
  }

  // 2. Validate MCP-Protocol-Version
  const versionErr = validateProtocolVersion(req);
  if (versionErr) return versionErr;

  if (sessionId && transports.has(sessionId)) {
    // Reuse existing transport for this session
    transport = transports.get(sessionId)!;
  } else if (isInitializeRequest(parsedBody)) {
    // New initialization request — create transport and connect server
    const eventStore = new InMemoryEventStore();
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore,
      retryInterval: 3000,
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
        sessionCookieStore.set(sid, cookieStr);
      },
      onsessionclosed: (sid) => {
        transports.delete(sid);
        sessionCookieStore.delete(sid);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        transports.delete(sid);
        sessionCookieStore.delete(sid);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);

    const authInfo: AuthInfo = {
      token: `tk_${randomUUID().replace(/-/g, "")}`,
      clientId: "anonymous",
      scopes: ["mcp:tools", "mcp:resources", "mcp:prompts"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: { cookies: cookieStr },
    };

    try {
      return await transport.handleRequest(requestForTransport, { parsedBody, authInfo });
    } catch (err: any) {
      const sid = transport.sessionId;
      if (sid) {
        transports.delete(sid);
        sessionCookieStore.delete(sid);
      }
      return jsonRpcError(-32000, err.message || "Internal error", 500, req);
    }
  } else if (sessionId) {
    // Session was lost after server restart; Streamable HTTP Transport cannot be recovered
    return jsonRpcError(-32000, "Session expired, please re-initialize", 404, req);
  } else {
    // No session ID and not initialization
    return jsonRpcError(-32000, "Bad Request: No valid session ID provided", 400, req);
  }

  // No authentication required — construct anonymous authInfo for existing sessions
  const authInfo: AuthInfo = {
    token: `tk_${randomUUID().replace(/-/g, "")}`,
    clientId: "anonymous",
    scopes: ["mcp:tools", "mcp:resources", "mcp:prompts"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { cookies: cookieStr },
  };

  return transport.handleRequest(requestForTransport, { parsedBody, authInfo });
}

// ─── DELETE Handler ──────────────────────────────────────────────────

export async function handleMcpDelete(req: NextRequest): Promise<Response> {
  const sessionId = req.headers.get("mcp-session-id");
  if (!sessionId) {
    return jsonRpcError(-32000, "Bad Request: No valid session ID provided", 400, req);
  }

  if (!transports.has(sessionId)) {
    return jsonRpcError(-32000, "Not Found: Session terminated or unknown", 404, req);
  }

  const transport = transports.get(sessionId)!;

  let response: Response;
  try {
    response = await transport.handleRequest(req, { authInfo: undefined });
  } finally {
    transports.delete(sessionId);
    sessionCookieStore.delete(sessionId);
  }

  return response;
}

// ─── OPTIONS Handler ─────────────────────────────────────────────────

export function mcpOptionsHandler(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      ...buildCorsHeaders(),
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
    },
  });
}
