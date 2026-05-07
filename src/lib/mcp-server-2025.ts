import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { z } from "zod/v4";
import { DEFAULT_MODEL, sunoApi } from "./SunoApi";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// ─── Session Cookie Store ────────────────────────────────────────────

/** Maps MCP sessionId to the cookie string captured at connection time. */
export const sessionCookieStore = new Map<string, string>();

export function getSessionCookies(sessionId: string | undefined): string {
  return sessionId ? sessionCookieStore.get(sessionId) ?? "" : "";
}

// ─── Shared Task Infrastructure ──────────────────────────────────────

const taskStore = new InMemoryTaskStore();

// ─── Tool Result Builder ─────────────────────────────────────────────

function buildToolResult(toolResult: unknown): CallToolResult {
  if (Array.isArray(toolResult) && toolResult.length > 0) {
    const first = toolResult[0];
    if (first && typeof first === "object" && ("audio_url" in first || "video_url" in first)) {
      const content: CallToolResult["content"] = (toolResult as any[]).flatMap((clip: any) => {
        const items: CallToolResult["content"] = [];
        if (clip.title) {
          items.push({ type: "text" as const, text: `Title: ${clip.title}` });
        }
        if (clip.audio_url) {
          items.push({
            type: "resource_link" as const,
            uri: clip.audio_url,
            name: clip.title ? `${clip.title}.mp3` : "audio.mp3",
            mimeType: "audio/mpeg",
            description: clip.title ? `${clip.title} audio` : "Generated audio",
          });
        }
        if (clip.video_url) {
          items.push({
            type: "resource_link" as const,
            uri: clip.video_url,
            name: clip.title ? `${clip.title}.mp4` : "video.mp4",
            mimeType: "video/mp4",
            description: clip.title ? `${clip.title} video` : "Generated video",
          });
        }
        return items;
      });
      return { content, isError: false };
    }
  }

  const text =
    typeof toolResult === "string"
      ? toolResult
      : JSON.stringify(toolResult, null, 2);
  return { content: [{ type: "text" as const, text }], isError: false };
}

function buildToolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ─── Common Annotations ──────────────────────────────────────────────

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
  idempotentHint: true,
} as const;

const GENERATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
  idempotentHint: false,
} as const;

// ─── Generation Runner (shared by sync + task tools) ─────────────────

async function runGenerationTool(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string | undefined
): Promise<CallToolResult> {
  const cookies = getSessionCookies(sessionId);
  const api = await sunoApi(cookies);

  try {
    let result: unknown;
    switch (toolName) {
      case "generate_music":
        result = await api.generate(
          String(args.prompt),
          Boolean(args.make_instrumental),
          args.model ? String(args.model) : DEFAULT_MODEL,
          Boolean(args.wait_audio)
        );
        break;
      case "generate_custom_music":
        result = await api.custom_generate(
          String(args.prompt),
          String(args.tags),
          String(args.title),
          Boolean(args.make_instrumental),
          args.model ? String(args.model) : DEFAULT_MODEL,
          Boolean(args.wait_audio),
          args.negative_tags ? String(args.negative_tags) : undefined
        );
        break;
      case "extend_audio":
        result = await api.extendAudio(
          String(args.audio_id),
          args.prompt ? String(args.prompt) : "",
          typeof args.continue_at === "number" ? args.continue_at : 0,
          args.tags ? String(args.tags) : "",
          args.negative_tags ? String(args.negative_tags) : "",
          args.title ? String(args.title) : "",
          args.model ? String(args.model) : undefined,
          Boolean(args.wait_audio)
        );
        break;
      case "generate_sound":
        result = await api.generateSound(
          String(args.prompt),
          Boolean(args.loop),
          args.model ? String(args.model) : undefined,
          Boolean(args.wait_audio),
          typeof args.tempo === "number" ? args.tempo : undefined,
          args.key ? String(args.key) : undefined
        );
        break;
      default:
        return buildToolError(`Unknown generation tool: ${toolName}`);
    }
    return buildToolResult(result);
  } catch (err: any) {
    return buildToolError(err.message || String(err));
  }
}

// ─── Task Tool Registration Helper ───────────────────────────────────

function registerTaskTool(
  server: McpServer,
  name: string,
  title: string,
  description: string,
  inputSchema: Record<string, any>,
  syncToolName: string
) {
  server.experimental.tasks.registerToolTask(
    name,
    {
      title,
      description,
      inputSchema,
      annotations: GENERATION_ANNOTATIONS,
    },
    {
      async createTask(args: any, extra: any) {
        const task = await extra.taskStore.createTask({
          ttl: extra.taskRequestedTtl ?? 300_000,
        });

        (async () => {
          const result = await runGenerationTool(
            syncToolName,
            args as Record<string, unknown>,
            extra.sessionId
          );
          await extra.taskStore.storeTaskResult(
            task.taskId,
            result.isError ? "failed" : "completed",
            result
          );
        })();

        return { task };
      },

      async getTask(_args: any, extra: any) {
        return extra.taskStore.getTask(extra.taskId);
      },

      async getTaskResult(_args: any, extra: any) {
        const result = await extra.taskStore.getTaskResult(extra.taskId);
        return result ?? buildToolError("Task result not found");
      },
    }
  );
}

// ─── Schema Constants (reused by sync + task tools) ──────────────────

const GENERATE_MUSIC_SCHEMA = {
  prompt: z.string().describe("Text description of the music to generate"),
  make_instrumental: z.boolean().optional().describe("Whether the generated audio should be instrumental only"),
  model: z.string().optional().describe("Model name to use for generation (default: chirp-fenix)"),
  wait_audio: z.boolean().optional().describe("If true, blocks until audio generation is complete (up to ~100s)"),
};

const GENERATE_CUSTOM_MUSIC_SCHEMA = {
  prompt: z.string().describe("Lyrics or description for the music"),
  tags: z.string().describe("Style tags / genre (e.g., 'pop, upbeat')"),
  title: z.string().describe("Title of the song"),
  make_instrumental: z.boolean().optional().describe("Whether the generated audio should be instrumental only"),
  model: z.string().optional().describe("Model name to use (default: chirp-fenix)"),
  wait_audio: z.boolean().optional().describe("If true, blocks until audio generation is complete (up to ~100s)"),
  negative_tags: z.string().optional().describe("Tags to exclude from generation"),
};

const EXTEND_AUDIO_SCHEMA = {
  audio_id: z.string().describe("ID of the audio clip to extend"),
  prompt: z.string().optional().describe("Prompt for the extension"),
  continue_at: z.number().optional().describe("Timestamp in seconds to continue from. Default extends from end."),
  tags: z.string().optional().describe("Style tags for the extension"),
  negative_tags: z.string().optional().describe("Tags to exclude"),
  title: z.string().optional().describe("Title of the song"),
  model: z.string().optional().describe("Model name (default: chirp-fenix)"),
  wait_audio: z.boolean().optional().describe("Wait for generation to complete"),
};

const GENERATE_SOUND_SCHEMA = {
  prompt: z.string().describe("Text description of the sound effect"),
  loop: z.boolean().optional().describe("Whether the sound should loop"),
  model: z.string().optional().describe("Model name (default: chirp-fenix)"),
  wait_audio: z.boolean().optional().describe("Wait for generation to complete"),
  tempo: z.number().optional().describe("BPM of the generated sound effect"),
  key: z.string().optional().describe("Musical key of the generated sound effect"),
};

// ─── Server Factory ──────────────────────────────────────────────────

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "suno-api-mcp",
      version: "1.1.0",
      description: "MCP server exposing Suno AI music generation tools",
    },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: false },
        tasks: { requests: { tools: { call: {} } } },
      },
      instructions:
        "This server provides tools for Suno AI music generation. " +
        "Use generate_music for simple prompts, generate_custom_music for full control with lyrics/style/title, " +
        "generate_sound for sound effects, extend_audio to extend existing clips, " +
        "or the query tools (get_audio_info, get_account_limit) for read-only operations.",
      taskStore,
      taskMessageQueue: new InMemoryTaskMessageQueue(),
      defaultTaskPollInterval: 5000,
    }
  );

  // ─── Tool 1: generate_music ────────────────────────────────────────
  server.registerTool(
    "generate_music",
    {
      title: "Generate Music",
      description:
        "Generate music from a text prompt using Suno AI. Returns an array of audio clips.",
      inputSchema: GENERATE_MUSIC_SCHEMA,
      annotations: GENERATION_ANNOTATIONS,
    },
    async (args: any, extra: ToolExtra) => {
      const cookies = getSessionCookies(extra.sessionId);
      const api = await sunoApi(cookies);
      const result = await api.generate(
        String(args.prompt),
        Boolean(args.make_instrumental),
        args.model ? String(args.model) : DEFAULT_MODEL,
        Boolean(args.wait_audio)
      );
      return buildToolResult(result);
    }
  );

  // ─── Tool 2: generate_custom_music ─────────────────────────────────
  server.registerTool(
    "generate_custom_music",
    {
      title: "Generate Custom Music",
      description:
        "Generate music with full control over lyrics, style tags, and title.",
      inputSchema: GENERATE_CUSTOM_MUSIC_SCHEMA,
      annotations: GENERATION_ANNOTATIONS,
    },
    async (args: any, extra: ToolExtra) => {
      const cookies = getSessionCookies(extra.sessionId);
      const api = await sunoApi(cookies);
      const result = await api.custom_generate(
        String(args.prompt),
        String(args.tags),
        String(args.title),
        Boolean(args.make_instrumental),
        args.model ? String(args.model) : DEFAULT_MODEL,
        Boolean(args.wait_audio),
        args.negative_tags ? String(args.negative_tags) : undefined
      );
      return buildToolResult(result);
    }
  );

  // ─── Tool 3: extend_audio ──────────────────────────────────────────
  server.registerTool(
    "extend_audio",
    {
      title: "Extend Audio",
      description:
        "Extend an existing audio clip by generating additional content.",
      inputSchema: EXTEND_AUDIO_SCHEMA,
      annotations: GENERATION_ANNOTATIONS,
    },
    async (args: any, extra: ToolExtra) => {
      const cookies = getSessionCookies(extra.sessionId);
      const api = await sunoApi(cookies);
      const result = await api.extendAudio(
        String(args.audio_id),
        args.prompt ? String(args.prompt) : "",
        typeof args.continue_at === "number" ? args.continue_at : 0,
        args.tags ? String(args.tags) : "",
        args.negative_tags ? String(args.negative_tags) : "",
        args.title ? String(args.title) : "",
        args.model ? String(args.model) : undefined,
        Boolean(args.wait_audio)
      );
      return buildToolResult(result);
    }
  );

  // ─── Tool 4: concat_audio ──────────────────────────────────────────
  server.registerTool(
    "concat_audio",
    {
      title: "Concatenate Audio",
      description: "Concatenate a clip to generate the full song.",
      inputSchema: {
        clip_id: z.string().describe("ID of the audio clip to concatenate"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (args: any, extra: ToolExtra) => {
      const cookies = getSessionCookies(extra.sessionId);
      const api = await sunoApi(cookies);
      const result = await api.concatenate(String(args.clip_id));
      return buildToolResult(result);
    }
  );

  // ─── Tool 5: generate_lyrics ───────────────────────────────────────
  server.registerTool(
    "generate_lyrics",
    {
      title: "Generate Lyrics",
      description: "Generate song lyrics based on a text prompt.",
      inputSchema: {
        prompt: z.string().describe("Prompt describing the desired lyrics"),
      },
      annotations: GENERATION_ANNOTATIONS,
    },
    async (args: any, extra: ToolExtra) => {
      const cookies = getSessionCookies(extra.sessionId);
      const api = await sunoApi(cookies);
      const result = await api.generateLyrics(String(args.prompt));
      return buildToolResult(result);
    }
  );

  // ─── Tool 6: get_audio_info ────────────────────────────────────────
  server.registerTool(
    "get_audio_info",
    {
      title: "Get Audio Info",
      description:
        "Retrieve audio information by clip IDs or list recent clips by page.",
      inputSchema: {
        ids: z.array(z.string()).optional().describe("Array of audio clip IDs to fetch"),
        page: z.string().optional().describe("Page number for paginated listing"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any, extra: ToolExtra) => {
      const cookies = getSessionCookies(extra.sessionId);
      const api = await sunoApi(cookies);
      const ids = Array.isArray(args.ids)
        ? args.ids.map((x: unknown) => String(x))
        : undefined;
      const page = args.page ? String(args.page) : undefined;
      const result = await api.get(ids, page ?? null);
      return buildToolResult(result);
    }
  );

  // ─── Tool 7: get_account_limit ─────────────────────────────────────
  server.registerTool(
    "get_account_limit",
    {
      title: "Get Account Limit",
      description: "Get the current Suno account credits and usage information.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (_args: any, extra: ToolExtra) => {
      const cookies = getSessionCookies(extra.sessionId);
      const api = await sunoApi(cookies);
      const result = await api.get_credits();
      return buildToolResult(result);
    }
  );

  // ─── Tool 8: generate_sound ────────────────────────────────────────
  server.registerTool(
    "generate_sound",
    {
      title: "Generate Sound Effect",
      description: "Generate a sound effect based on a text prompt.",
      inputSchema: GENERATE_SOUND_SCHEMA,
      annotations: GENERATION_ANNOTATIONS,
    },
    async (args: any, extra: ToolExtra) => {
      const cookies = getSessionCookies(extra.sessionId);
      const api = await sunoApi(cookies);
      const result = await api.generateSound(
        String(args.prompt),
        Boolean(args.loop),
        args.model ? String(args.model) : undefined,
        Boolean(args.wait_audio),
        typeof args.tempo === "number" ? args.tempo : undefined,
        args.key ? String(args.key) : undefined
      );
      return buildToolResult(result);
    }
  );

  // ─── Tool 9: generate_stems ────────────────────────────────────────
  server.registerTool(
    "generate_stems",
    {
      title: "Generate Stems",
      description:
        "Generate separated instrument/vocal tracks (stems) for a song.",
      inputSchema: {
        song_id: z.string().describe("ID of the song to generate stems for"),
      },
      annotations: GENERATION_ANNOTATIONS,
    },
    async (args: any, extra: ToolExtra) => {
      const cookies = getSessionCookies(extra.sessionId);
      const api = await sunoApi(cookies);
      const result = await api.generateStems(String(args.song_id));
      return buildToolResult(result);
    }
  );

  // ─── Tool 10: get_aligned_lyrics ───────────────────────────────────
  server.registerTool(
    "get_aligned_lyrics",
    {
      title: "Get Aligned Lyrics",
      description: "Get word-level lyric alignment timestamps for a song.",
      inputSchema: {
        song_id: z.string().describe("ID of the song"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any, extra: ToolExtra) => {
      const cookies = getSessionCookies(extra.sessionId);
      const api = await sunoApi(cookies);
      const result = await api.getLyricAlignment(String(args.song_id));
      return buildToolResult(result);
    }
  );

  // ─── Task-Based Tools ──────────────────────────────────────────────
  registerTaskTool(server, "generate_music_task", "Generate Music (Task)", "Async music generation with task support.", GENERATE_MUSIC_SCHEMA, "generate_music");
  registerTaskTool(server, "generate_custom_music_task", "Generate Custom Music (Task)", "Async custom music generation with task support.", GENERATE_CUSTOM_MUSIC_SCHEMA, "generate_custom_music");
  registerTaskTool(server, "extend_audio_task", "Extend Audio (Task)", "Async audio extension with task support.", EXTEND_AUDIO_SCHEMA, "extend_audio");
  registerTaskTool(server, "generate_sound_task", "Generate Sound Effect (Task)", "Async sound effect generation with task support.", GENERATE_SOUND_SCHEMA, "generate_sound");

  return server;
}
