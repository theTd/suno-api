import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { z } from "zod/v4";
import { ClipAudioNotReadyError, DEFAULT_MODEL, isUnusableAudioUrl, rewriteForbiddenAudioUrls, sunoApi } from "./SunoApi";
import type { PreviewJobSnapshot } from "./SunoApi";
import { parseGenerationExtras, SOUND_KEY_HINT, SOUND_KEY_PATTERN } from "./generation-options";
import { listSunoModels } from "./suno-models";
import { publicOriginFromEnv } from "./public-origin";
import { hasUnlockConsent } from "./unlock-consent";

type SunoClient = Awaited<ReturnType<typeof sunoApi>>;

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// ─── Session Cookie / Origin Store ───────────────────────────────────

/** Maps MCP sessionId to the cookie string captured at connection time. */
export const sessionCookieStore = new Map<string, string>();
/** Maps MCP sessionId to the public origin of the connecting client. */
export const sessionOriginStore = new Map<string, string>();

export function getSessionCookies(sessionId: string | undefined): string {
  return sessionId ? sessionCookieStore.get(sessionId) ?? "" : "";
}

export function getSessionOrigin(sessionId: string | undefined): string {
  const env = publicOriginFromEnv();
  if (env) return env;
  return sessionId ? sessionOriginStore.get(sessionId) ?? "" : "";
}

// ─── Shared Task Infrastructure ──────────────────────────────────────

const taskStore = new InMemoryTaskStore();

// ─── Tool Result Builder ─────────────────────────────────────────────

const MAX_EMBED_AUDIO_BYTES = 2 * 1024 * 1024;

function clipMetaText(clip: any): string {
  const id = clip.id ? String(clip.id) : undefined;
  return JSON.stringify({
    id,
    title: clip.title,
    status: clip.status,
    duration: clip.duration,
    audio_url: clip.audio_url,
    unlocked: id ? hasUnlockConsent(id) : false,
  });
}

function extFromContentType(contentType: string): string {
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mp4")) return "m4a";
  return "mp3";
}

async function handleMasterDownload(args: any, extra: ToolExtra): Promise<CallToolResult> {
  const clipId = String(args.clip_id);
  if (!hasUnlockConsent(clipId)) return previewUnlockRequiredError(clipId);
  const cookies = getSessionCookies(extra.sessionId);
  const api = await sunoApi(cookies);
  try {
    return await buildMasterDownloadResult(api, clipId, getSessionOrigin(extra.sessionId));
  } catch (err: any) {
    if (err instanceof ClipAudioNotReadyError) {
      return buildToolError(
        `Clip ${clipId} is authorized to unlock but the master is not ready yet (status must be complete). ` +
          `Wait and retry download_audio_file; the user does not need to click 「解锁母带」 again.`
      );
    }
    return buildToolError(err?.message || String(err));
  }
}

function previewUnlockRequiredError(clipId: string): CallToolResult {
  return buildToolError(
    `Clip ${clipId} has not been unlocked on the preview page. ` +
      `Tell the user to open /mcp/preview, listen, and click 「解锁母带」. ` +
      `Only call this tool after get_audio_info shows unlocked=true for this id, ` +
      `or the user confirms they clicked unlock.`
  );
}

async function buildMasterDownloadResult(
  api: SunoClient,
  clipId: string,
  origin: string
): Promise<CallToolResult> {
  const { buffer, contentType } = await api.getPlayableAudio(clipId);
  const ext = extFromContentType(contentType);
  const filename = `${clipId}.${ext}`;
  const fileUrl = origin ? `${origin}/api/file/${clipId}` : null;
  const content: CallToolResult["content"] = [
    {
      type: "text",
      text: JSON.stringify({
        id: clipId,
        unlocked: true,
        bytes: buffer.length,
        contentType,
        file_url: fileUrl,
      }),
    },
  ];
  if (buffer.length <= MAX_EMBED_AUDIO_BYTES && contentType.startsWith("audio/")) {
    content.push({ type: "audio", data: buffer.toString("base64"), mimeType: contentType });
  }
  if (fileUrl) {
    content.push({
      type: "resource_link",
      uri: fileUrl,
      name: filename,
      mimeType: contentType,
      description: "Unlocked master download",
    });
  }
  return { content, isError: false };
}

async function buildToolResult(
  toolResult: unknown,
  opts?: { api?: SunoClient; embedAudio?: boolean; sessionId?: string }
): Promise<CallToolResult> {
  const origin = getSessionOrigin(opts?.sessionId);
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
        { buffer: Buffer; contentType: string; transcoded?: boolean } | { job: PreviewJobSnapshot }
      >();
      if (opts?.embedAudio && opts.api && readyClips.length > 0) {
        // Non-blocking: return the captured preview as MP3 bytes when ready,
        // otherwise join the background harvest and report live status as text.
        const results = await Promise.all(
          readyClips.map(async (clip) => {
            const id = String(clip.id);
            try {
              const cached = await opts.api!.getCachedPreviewMp3(id);
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
          false,
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
          false,
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
          false
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
    // Only generate_sound still supports the wait_audio/embed mode (default on);
    // song tools always return immediately and never embed preview audio.
    const embedAudio = toolName === "generate_sound" && args.wait_audio !== false;
    return buildToolResult(result, { api, embedAudio, sessionId });
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
  "Model `mv` id to use for generation (e.g. 'chirp-hawk' for v6). " +
  "Call list_models for the full catalog with tiers and per-tab defaults. " +
  "Custom model ids from Create Custom Model (Beta) are also accepted.";

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
  prompt: z.string().describe(
    "Style + theme description of the music (e.g. 'melancholic piano ballad about autumn'). " +
    "This is NOT where lyrics go — Suno auto-writes lyrics from this description. " +
    "If you have specific lyrics, use generate_custom_music instead."
  ),
  make_instrumental: z.boolean().optional().describe("Whether the generated audio should be instrumental only"),
  model: z.string().optional().describe(MODEL_DESCRIPTION),
  ...EXTRAS_SCHEMA_FIELDS,
};

const GENERATE_CUSTOM_MUSIC_SCHEMA = {
  prompt: z.string().describe(
    "The full song LYRICS (with [Verse]/[Chorus] structure if desired). " +
    "Style/genre does NOT go here — put it in `tags`. " +
    "If you only have a style/theme idea and no lyrics, use generate_music instead."
  ),
  tags: z.string().describe("Style tags / genre (e.g., 'pop, upbeat, female vocal')"),
  title: z.string().describe("Title of the song"),
  make_instrumental: z.boolean().optional().describe("Whether the generated audio should be instrumental only"),
  model: z.string().optional().describe(MODEL_DESCRIPTION),
  negative_tags: z.string().optional().describe("Tags to exclude from generation"),
  ...EXTRAS_SCHEMA_FIELDS,
};

const EXTEND_AUDIO_SCHEMA = {
  audio_id: z.string().describe("ID of the audio clip to extend"),
  prompt: z.string().optional().describe("Lyrics/text for the extension content (style goes in `tags`)"),
  continue_at: z.number().optional().describe("Timestamp in seconds to continue from. Default extends from end."),
  tags: z.string().optional().describe("Style tags for the extension"),
  negative_tags: z.string().optional().describe("Tags to exclude"),
  title: z.string().optional().describe("Title of the song"),
  model: z.string().optional().describe(MODEL_DESCRIPTION),
};

const GENERATE_SOUND_SCHEMA = {
  prompt: z.string().describe("Text description of the sound effect"),
  loop: z.boolean().optional().describe("Whether the sound should loop"),
  model: z.string().optional().describe(MODEL_DESCRIPTION),
  wait_audio: z.boolean().default(true).describe("Defaults to true. Wait until clips are ready and embed playable audio bytes (SFX). Set false to return clip ids immediately."),
  tempo: z.number().int().min(1).max(300).optional().describe("BPM of the generated sound effect (1-300). Omit for auto."),
  key: z.string().refine((v) => SOUND_KEY_PATTERN.test(v), { message: `key must be one of ${SOUND_KEY_HINT}` }).optional().describe("Musical key from the official Key picker (C, C#, D, D#, E, F, F#, G, G#, A, A#, B, optionally + 'm' for minor). Omit for Any."),
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
        "Routing: generate_music takes a STYLE/THEME description and auto-writes lyrics — never put full lyrics there. " +
        "generate_custom_music takes full LYRICS in `prompt`, with style/genre in `tags` and a `title` (all three required). " +
        "Use generate_sound for sound effects, extend_audio to extend existing clips, " +
        "or the query tools (get_audio_info, get_account_limit) for read-only operations. " +
        "Do NOT call download_audio or download_audio_file until the user has clicked 「解锁母带」 on /mcp/preview for that clip. " +
        "Call list_models to see the available generation models with tiers and defaults.",
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
        "Generate music from a style/theme text prompt using Suno AI; lyrics are auto-written from the prompt. " +
        "Do NOT pass full lyrics here — if you have specific lyrics, use generate_custom_music (prompt=lyrics, tags=style, title). " +
        "Consumes shared-account credits (2 clips per call; check get_account_limit first). " +
        "Returns an array of audio clips.",
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
        false,
        extra.signal,
        extrasFromArgs(args)
      );
      return buildToolResult(result, { api, sessionId: extra.sessionId });
    }
  );

  // ─── Tool 2: generate_custom_music ─────────────────────────────────
  server.registerTool(
    "generate_custom_music",
    {
      title: "Generate Custom Music",
      description:
        "Generate music with full control: prompt = the full song LYRICS, tags = style/genre, title = song title (all three required). " +
        "For a style/theme idea without lyrics, use generate_music instead. " +
        "Consumes shared-account credits (2 clips per call; check get_account_limit first).",
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
        false,
        args.negative_tags ? String(args.negative_tags) : undefined,
        extra.signal,
        extrasFromArgs(args)
      );
      return buildToolResult(result, { api, sessionId: extra.sessionId });
    }
  );

  // ─── Tool 3: extend_audio ──────────────────────────────────────────
  server.registerTool(
    "extend_audio",
    {
      title: "Extend Audio",
      description:
        "Extend an existing audio clip by generating additional content. " +
        "prompt = lyrics/text for the continuation (style goes in `tags`). Consumes shared-account credits.",
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
        false,
        extra.signal
      );
      return buildToolResult(result, { api, sessionId: extra.sessionId });
    }
  );

  // ─── Tool 4: concat_audio ──────────────────────────────────────────
  server.registerTool(
    "concat_audio",
    {
      title: "Concatenate Audio",
      description: "Concatenate a clip to generate the full song. Consumes shared-account credits.",
      inputSchema: {
        clip_id: z.string().describe("ID of the audio clip to concatenate"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async (args: any, extra: ToolExtra) => {
      const cookies = getSessionCookies(extra.sessionId);
      const api = await sunoApi(cookies);
      const result = await api.concatenate(String(args.clip_id));
      return buildToolResult(result, { sessionId: extra.sessionId });
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
      return buildToolResult(result, { sessionId: extra.sessionId });
    }
  );

  // ─── Tool 6: get_audio_info ────────────────────────────────────────
  server.registerTool(
    "get_audio_info",
    {
      title: "Get Audio Info",
      description:
        "Retrieve audio information by clip IDs or list recent clips by page. Each returned page is sorted newest-first by created_at.",
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
      return buildToolResult(result, { sessionId: extra.sessionId });
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
      return buildToolResult(result, { sessionId: extra.sessionId });
    }
  );

  // ─── Tool 7b: list_models ─────────────────────────────────────────
  server.registerTool(
    "list_models",
    {
      title: "List Models",
      description:
        "List the generation models offered by the official Suno web client " +
        "(v6 / v6-wild / v6-mini with tiers, descriptions and per-tab defaults). " +
        "Model ids are accepted by the `model` argument of all generation tools.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      return buildToolResult({ default_model: DEFAULT_MODEL, models: listSunoModels() });
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
      return buildToolResult(result, { api, embedAudio: waitAudio, sessionId: extra.sessionId });
    }
  );

  // ─── Tool 9: download_audio ────────────────────────────────────────
  server.registerTool(
    "download_audio",
    {
      title: "Unlock & Download Audio",
      description:
        "Download a clip's unlocked master file. ONLY call this after the user has clicked 「解锁母带」 on /mcp/preview for this clip. " +
        "Refuses if preview unlock consent is missing. Consumes a Premier download credit if Suno has not already unlocked the clip.",
      inputSchema: {
        clip_id: z.string().describe("ID of the clip to download. Requires prior preview-page unlock consent."),
      },
      annotations: GENERATION_ANNOTATIONS,
    },
    handleMasterDownload
  );

  // ─── Tool 9b: download_audio_file ──────────────────────────────────
  server.registerTool(
    "download_audio_file",
    {
      title: "Download Unlocked Audio File",
      description:
        "Download the master audio binary for a clip that the user has already unlocked on /mcp/preview. " +
        "HARD REQUIREMENT: the user must click 「解锁母带」 on the preview page first. Do not call this because a clip finished generating, " +
        "because get_audio_info returned an id, or because you want to be helpful — only after explicit preview unlock consent " +
        "(get_audio_info.unlocked=true, or the user says they clicked unlock). " +
        "Returns file_url (/api/file/{id}) — the only HTTP download path — and audio bytes when small enough.",
      inputSchema: {
        clip_id: z.string().describe("ID of the clip whose master file to fetch. Requires prior preview-page unlock consent."),
      },
      annotations: GENERATION_ANNOTATIONS,
    },
    handleMasterDownload
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
      return buildToolResult(result, { sessionId: extra.sessionId });
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
      return buildToolResult(result, { sessionId: extra.sessionId });
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
      const origin = getSessionOrigin(undefined);
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
