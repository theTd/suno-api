import { GenerationExtras, validateGenerationExtras } from './SunoApi';

/**
 * Endpoint-agnostic parsing/validation for the optional generation tuning
 * knobs. Shared by the REST routes and the MCP server so both surfaces apply
 * identical rules and error messages.
 */

function toOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  if (Number.isNaN(num))
    throw new Error(`Expected a number, got ${JSON.stringify(value)}`);
  return num;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Expected a boolean, got ${JSON.stringify(value)}`);
}

/**
 * Extracts GenerationExtras from a raw request body / tool args object.
 * Unknown keys are ignored; present-but-invalid values throw descriptive Errors.
 */
export function parseGenerationExtras(input: unknown): GenerationExtras {
  if (!input || typeof input !== 'object') return {};
  const src = input as Record<string, unknown>;
  const extras: GenerationExtras = {};

  const weirdness = toOptionalNumber(src.weirdness);
  if (weirdness !== undefined) extras.weirdness = weirdness;
  const styleInfluence = toOptionalNumber(src.style_influence);
  if (styleInfluence !== undefined) extras.style_influence = styleInfluence;
  const variety = toOptionalNumber(src.variety);
  if (variety !== undefined) extras.variety = variety;
  const duration = toOptionalNumber(src.duration);
  if (duration !== undefined) extras.duration = duration;

  if (src.vocal_gender !== undefined && src.vocal_gender !== null && src.vocal_gender !== '') {
    const gender = String(src.vocal_gender).toLowerCase();
    if (gender !== 'm' && gender !== 'f')
      throw new Error("vocal_gender must be 'm' or 'f'");
    extras.vocal_gender = gender;
  }

  const maxMode = toOptionalBoolean(src.is_max_mode);
  if (maxMode !== undefined) extras.is_max_mode = maxMode;
  const personalization = toOptionalBoolean(src.use_personalization);
  if (personalization !== undefined) extras.use_personalization = personalization;

  validateGenerationExtras(extras);
  return extras;
}

/** Validates an optional sound-effect BPM (integer 1-300, undefined when unset). */
export function parseSoundTempo(input: unknown): number | undefined {
  const tempo = toOptionalNumber(input);
  if (tempo === undefined) return undefined;
  if (!Number.isInteger(tempo) || tempo < 1 || tempo > 300)
    throw new Error('tempo must be an integer between 1 and 300');
  return tempo;
}

/** Validates an optional musical key ('C', 'F#', 'A#m'; undefined when unset). */
export function parseSoundKey(input: unknown): string | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  const key = String(input).trim();
  if (!/^[A-G]#?m?$/.test(key))
    throw new Error(`key must look like 'C', 'F#' or 'A#m', got ${JSON.stringify(input)}`);
  return key;
}
