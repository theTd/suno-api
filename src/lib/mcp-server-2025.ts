import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { z } from "zod/v4";
import { DEFAULT_MODEL, isUnusableAudioUrl, rewriteForbiddenAudioUrls, sunoApi } from "./SunoApi";
import type { PreviewJobSnapshot } from "./SunoApi";
import { parseGenerationExtras } from "./generation-options";

type SunoClient = Awaited<ReturnType<typeof sunoApi>>;

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

const MAX_EMBED_AUDIO_BYTES = 2 * 1024 * 1024;

function clipMetaText(clip: any): string {
  return JSON.stringify({
    id: clip.id,
    title: clip.title,
    status: clip.status,
    duration: clip.duration,
    audio_url: clip.audio_url,
  });
}

async function buildToolResult(
  toolResult: unknown,
  opts?: { api?: SunoClient; embedAudio?: boolean }
): Promise<CallToolResult> {
  const origin = (process.env.SUNO_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  toolResult = origin ? rewriteForbiddenAudioUrls(toolResult, origin) : toolResult;
  if (Array.isArray(toolResult) && toolResult.length > 0) {
    const first = toolResult[0];
    if (first && typeof first === "object" && ("audio_url" in first || "video_url" in first)) {
      const clips = toolResult as any[];
      const content: CallToolResult["content"] = [];
      const readyClips = clips.filter(
        (clip) => clip.id && (clip.status === "complete" || clip.status === "streaming")
      );
      const harvested = new Map<
        string,
        { buffer: Buffer; contentType: string } | { job: PreviewJobSnapshot }
      >();
      if (opts?.embedAudio && opts.api && readyClips.length > 0) {
        // Non-blocking: return the cached audio when ready, otherwise join the
        // background harvest and report its live status as text.
        const results = await Promise.all(
          readyClips.map(async (clip) => {
            const id = String(clip.id);
            try {
              const cached = await opts.api!.getCachedPreview(id);
              if (cached) return [id, cached] as const;
              opts.api!.beginPreviewHarvest(id);
              return [id, { job: opts.api!.previewJobStatus(id) }] as const;
            } catch (err: any) {
              return [
                id,
                {
                  job: {
                    state: 'error' as const,
                    queuePosition: 0,
                    progressPercent: null,
                    currentSec: 0,
                    durationSec: 0,
                    bytes: 0,
                    error: err?.message || String(err)
                  }
                }
              ] as const;
            }
          })
        );
        for (const [id, value] of results) harvested.set(id, value as any);
      }
      for (const clip of clips) {
        content.push({ type: "text" as const, text: clipMetaText(clip) });
        const audio = clip.id ? harvested.get(String(clip.id)) : undefined;
        if (audio && "buffer" in audio) {
          if (audio.buffer.length <= MAX_EMBED_AUDIO_BYTES && audio.contentType.startsWith("audio/")) {
            content.push({
              type: "audio" as const,
              data: audio.buffer.toString("base64"),
              mimeType: audio.contentType,
            });
          } else {
            content.push({
              type: "text" as const,
              text: `Audio for ${clip.id} is ${audio.buffer.length} bytes (${audio.contentType}); too large to embed. Use audio_url if present.`,
            });
          }
        } else if (audio && "job" in audio) {
          const job = audio.job;
          const detail = job.error
            ? `capture failed: ${job.error}`
            : job.state === "capturing"
              ? job.durationSec > 0
                ? `capturing ${job.progressPercent ?? 0}% (${job.currentSec}s/${job.durationSec}s)`
                : `capturing (${job.currentSec}s played so far)`
              : job.state === "queued"
                ? `queued at position #${job.queuePosition}`
                : "waiting for clip to be ready";
          content.push({
            type: "text" as const,
            text: `Preview for ${clip.id}: ${detail}. Stream ${origin || "<server>"}/api/preview/${clip.id}?stream=1 to listen while the capture is still running, or poll the same URL without ?stream=1 for status.`,
          });
          const alreadyLinked =
            typeof clip.audio_url === "string" && clip.audio_url.includes("/api/preview/");
          if (origin && !alreadyLinked) {
            content.push({
              type: "resource_link" as const,
              uri: `${origin}/api/preview/${clip.id}?stream=1`,
              name: clip.title ? `${clip.title}.webm` : "preview.webm",
              description: "Progressive audio stream (chunked) — starts playing before the capture finishes",
            });
          }
        }
        if (clip.audio_url && !isUnusableAudioUrl(clip.audio_url)) {
          content.push({
            type: "resource_link" as const,
            uri: clip.audio_url,
            name: clip.title ? `${clip.title}.m4a` : "preview.m4a",
            mimeType: "audio/mp4",
            description: clip.title ? `${clip.title} preview (no unlock)` : "Preview audio (no unlock)",
          });
        }
        if (clip.video_url && !isUnusableAudioUrl(clip.video_url)) {
          content.push({
            type: "resource_link" as const,
            uri: clip.video_url,
            name: clip.title ? `${clip.title}.mp4` : "video.mp4",
            mimeType: "video/mp4",
            description: clip.title ? `${clip.title} video` : "Generated video",
          });
        }
      }
      return {
        content,
        structuredContent: { clips },
        isError: false,
      };
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

// ─── Shared Extras Helper ────────────────────────────────────────────

/** Builds GenerationExtras from validated tool args (zod already type-checked them). */
function extrasFromArgs(args: Record<string, unknown>) {
  return parseGenerationExtras(args);
}

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
          Boolean(args.wait_audio),
          undefined,
          extrasFromArgs(args)
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
          args.negative_tags ? String(args.negative_tags) : undefined,
          undefined,
          extrasFromArgs(args)
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
          args.wait_audio !== false,
          typeof args.tempo === "number" ? args.tempo : undefined,
          args.key ? String(args.key) : undefined
        );
        break;
      default:
        return buildToolError(`Unknown generation tool: ${toolName}`);
    }
    const embedAudio = toolName === "generate_sound" ? args.wait_audio !== false : Boolean(args.wait_audio);
    return buildToolResult(result, { api, embedAudio });
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

const MODEL_DESCRIPTION =
  "Model name to use for generation: 'chirp-hawk' (v6, default), 'chirp-hawk-wild' (v6-wild), 'chirp-goose' (v6-mini), or a custom model id";

const EXTRAS_SCHEMA_FIELDS = {
  weirdness: z.number().min(0).max(100).optional()
    .describe("Weirdness slider, 0-100 (default 50 = omitted from the request)"),
  style_influence: z.number().min(0).max(100).optional()
    .describe("Style Influence slider, 0-100 (default 50 = omitted from the request)"),
  variety: z.number().int().min(0).max(4).optional()
    .describe("Variety slider, integer 0-4 (default 1)"),
  duration: z.number().int().min(10).max(360).optional()
    .describe("Fixed song length in seconds, 10-360. Omit for the model default length."),
  vocal_gender: z.enum(["m", "f"]).optional()
    .describe("Constrain the vocal gender. Omit to let the model decide."),
  is_max_mode: z.boolean().optional()
    .describe("Enable Max mode (as on the official Pro client)"),
  use_personalization: z.boolean().optional()
    .describe("Personalize the result with the account's 'My Taste' profile"),
} as const;

const GENERATE_MUSIC_SCHEMA = {
  prompt: z.string().describe("Text description of the music to generate"),
  make_instrumental: z.boolean().optional().describe("Whether the generated audio should be instrumental only"),
  model: z.string().optional().describe(MODEL_DESCRIPTION),
  wait_audio: z.boolean().optional().describe("If true, blocks until audio generation is complete (up to ~100s)"),
  ...EXTRAS_SCHEMA_FIELDS,
};

const GENERATE_CUSTOM_MUSIC_SCHEMA = {
  prompt: z.string().describe("Lyrics or description for the music"),
  tags: z.string().describe("Style tags / genre (e.g., 'pop, upbeat')"),
  title: z.string().describe("Title of the song"),
  make_instrumental: z.boolean().optional().describe("Whether the generated audio should be instrumental only"),
  model: z.string().optional().describe(MODEL_DESCRIPTION),
  wait_audio: z.boolean().optional().describe("If true, blocks until audio generation is complete (up to ~100s)"),
  negative_tags: z.string().optional().describe("Tags to exclude from generation"),
  ...EXTRAS_SCHEMA_FIELDS,
};

const EXTEND_AUDIO_SCHEMA = {
  audio_id: z.string().describe("ID of the audio clip to extend"),
  prompt: z.string().optional().describe("Prompt for the extension"),
  continue_at: z.number().optional().describe("Timestamp in seconds to continue from. Default extends from end."),
  tags: z.string().optional().describe("Style tags for the extension"),
  negative_tags: z.string().optional().describe("Tags to exclude"),
  title: z.string().optional().describe("Title of the song"),
  model: z.string().optional().describe("Model name (default: chirp-hawk)"),
  wait_audio: z.boolean().optional().describe("Wait for generation to complete"),
};

const GENERATE_SOUND_SCHEMA = {
  prompt: z.string().describe("Text description of the sound effect"),
  loop: z.boolean().optional().describe("Whether the sound should loop"),
  model: z.string().optional().describe(MODEL_DESCRIPTION),
  wait_audio: z.boolean().default(true).describe("Defaults to true. Wait until clips are ready and embed playable audio bytes (SFX). Set false to return clip ids immediately."),
  tempo: z.number().int().min(1).max(300).optional().describe("BPM of the generated sound effect (1-300). Omit for auto."),
  key: z.string().regex(/^[A-G]#?m?$/).optional().describe("Musical key, e.g. 'C', 'F#' or 'A#m' (m = minor). Omit for any key."),
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
        Boolean(args.wait_audio),
        extra.signal,
        extrasFromArgs(args)
      );
      return buildToolResult(result, { api, embedAudio: Boolean(args.wait_audio) });
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
        args.negative_tags ? String(args.negative_tags) : undefined,
        extra.signal,
        extrasFromArgs(args)
      );
      return buildToolResult(result, { api, embedAudio: Boolean(args.wait_audio) });
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
        Boolean(args.wait_audio),
        extra.signal
      );
      return buildToolResult(result, { api, embedAudio: Boolean(args.wait_audio) });
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
      const waitAudio = args.wait_audio !== false;
      const result = await api.generateSound(
        String(args.prompt),
        Boolean(args.loop),
        args.model ? String(args.model) : undefined,
        waitAudio,
        typeof args.tempo === "number" ? args.tempo : undefined,
        args.key ? String(args.key) : undefined,
        extra.signal
      );
      return buildToolResult(result, { api, embedAudio: waitAudio });
    }
  );

  // ─── Tool 9: download_audio ────────────────────────────────────────
  server.registerTool(
    "download_audio",
    {
      title: "Unlock & Download Audio",
      description:
        "Unlock a completed clip and download the master file. Consumes a Premier download credit if the clip is not already unlocked. Use after previewing.",
      inputSchema: {
        clip_id: z.string().describe("ID of the clip to unlock and download"),
      },
      annotations: GENERATION_ANNOTATIONS,
    },
    async (args: any, extra: ToolExtra) => {
      const cookies = getSessionCookies(extra.sessionId);
      const api = await sunoApi(cookies);
      const clipId = String(args.clip_id);
      try {
        const { buffer, contentType } = await api.getPlayableAudio(clipId);
        const origin = (process.env.SUNO_PUBLIC_BASE_URL || "").replace(/\/$/, "");
        const content: CallToolResult["content"] = [
          { type: "text", text: JSON.stringify({ id: clipId, unlocked: true, bytes: buffer.length, contentType }) },
        ];
        if (buffer.length <= MAX_EMBED_AUDIO_BYTES && contentType.startsWith("audio/")) {
          content.push({ type: "audio", data: buffer.toString("base64"), mimeType: contentType });
        }
        if (origin) {
          content.push({
            type: "resource_link",
            uri: `${origin}/api/file/${clipId}`,
            name: `${clipId}.mp3`,
            mimeType: contentType,
            description: "Unlocked master download",
          });
        }
        return { content, isError: false };
      } catch (err: any) {
        return buildToolError(err?.message || String(err));
      }
    }
  );

  // ─── Tool 10: generate_stems ────────────────────────────────────────
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

  // ─── Tool 11: get_aligned_lyrics ───────────────────────────────────
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

  // ─── Streaming Preview Resource (protocol layer) ───────────────────
  // MCP resources themselves return complete content, so a live capture is
  // exposed as a reference: reading this resource reports the harvest status
  // and the progressive HTTP stream URL, which serves chunked audio while
  // the capture is still running (and replays instantly from cache later).
  server.registerResource(
    "preview_stream",
    new ResourceTemplate("suno://preview/{clip_id}", { list: undefined }),
    {
      title: "Streaming Preview",
      description:
        "Progressively stream a clip's in-player preview: open the returned stream_url for chunked audio that plays while the capture is still running. No unlock / no download credit.",
    },
    async (uri, variables) => {
      const clipId = Array.isArray(variables.clip_id)
        ? variables.clip_id[0]
        : variables.clip_id;
      if (!clipId) {
        return { contents: [{ uri: uri.href, text: "Missing clip_id in suno://preview/{clip_id}" }] };
      }
      const api = await sunoApi(getSessionCookies(undefined));
      const origin = (process.env.SUNO_PUBLIC_BASE_URL || "").replace(/\/$/, "");
      const status = api.previewJobStatus(clipId);
      const text = JSON.stringify(
        {
          clip_id: clipId,
          harvest: status ?? "not started (starts on first stream request)",
          stream_url: origin ? `${origin}/api/preview/${clipId}?stream=1` : null,
          note: "GET stream_url for a chunked progressive audio stream (Content-Type sniffed from the first captured chunk). Omit ?stream=1 to poll status instead.",
        },
        null,
        2
      );
      return { contents: [{ uri: uri.href, text }] };
    }
  );

  // ─── Task-Based Tools ──────────────────────────────────────────────
  registerTaskTool(server, "generate_music_task", "Generate Music (Task)", "Async music generation with task support.", GENERATE_MUSIC_SCHEMA, "generate_music");
  registerTaskTool(server, "generate_custom_music_task", "Generate Custom Music (Task)", "Async custom music generation with task support.", GENERATE_CUSTOM_MUSIC_SCHEMA, "generate_custom_music");
  registerTaskTool(server, "extend_audio_task", "Extend Audio (Task)", "Async audio extension with task support.", EXTEND_AUDIO_SCHEMA, "extend_audio");
  registerTaskTool(server, "generate_sound_task", "Generate Sound Effect (Task)", "Async sound effect generation with task support.", GENERATE_SOUND_SCHEMA, "generate_sound");

  return server;
}
