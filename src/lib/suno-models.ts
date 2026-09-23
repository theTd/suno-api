/**
 * Measured model catalog for the official Suno `/create` web client.
 *
 * Source: the model menu on suno.com/create (Simple / Advanced / Sounds tabs
 * all offer the same three entries; Simple + Advanced default to v6, Sounds
 * defaults to v6-mini). There is no listing API — the menu is frontend-static —
 * so this file is the single source of truth, shared by the REST routes and
 * the MCP server.
 *
 * `mv` ids are what `/api/generate/v2-web/` expects. Custom model ids minted
 * via "Create Custom Model (Beta)" are also accepted by the generate
 * endpoints; they are per-account and therefore not listed here.
 */

export type SunoModelTier = 'pro' | 'free';

export type CreateSurface = 'simple' | 'advanced' | 'sounds';

export interface SunoModelInfo {
  /** The `mv` value sent to `/api/generate/v2-web/`. */
  id: string;
  /** Label shown in the official model menu. */
  label: string;
  tier: SunoModelTier;
  /** Description shown in the official model menu. */
  description: string;
  /**
   * Which `/create` tabs preselect this model in the official client.
   * Informational only — the API default is DEFAULT_MODEL.
   */
  defaultFor: CreateSurface[];
  /** Whether the model is offered in the Sounds-tab model menu. */
  supportsSound: boolean;
}

/** Default `mv` for generation when the caller does not pick a model. */
export const DEFAULT_MODEL = 'chirp-hawk';

export const SUNO_MODELS: SunoModelInfo[] = [
  {
    id: 'chirp-hawk',
    label: 'v6',
    tier: 'pro',
    description: 'Powerful. Versatile. Refined. Our best model yet.',
    defaultFor: ['simple', 'advanced'],
    supportsSound: true
  },
  {
    id: 'chirp-hawk-wild',
    label: 'v6-wild',
    tier: 'pro',
    description: 'Best for experimental ideas.',
    defaultFor: [],
    supportsSound: true
  },
  {
    id: 'chirp-goose',
    label: 'v6-mini',
    tier: 'free',
    description: 'A free, more efficient version of premium v6 models.',
    defaultFor: ['sounds'],
    supportsSound: true
  }
];

/** Finds a catalog entry by `mv` id or menu label (case-insensitive). */
export function findSunoModel(idOrLabel?: string): SunoModelInfo | undefined {
  if (!idOrLabel) return undefined;
  const needle = idOrLabel.trim().toLowerCase();
  return SUNO_MODELS.find(
    (model) => model.id.toLowerCase() === needle || model.label.toLowerCase() === needle
  );
}

/**
 * Wire shape served by `GET /api/models` and MCP `list_models`.
 * snake_case, matching the `default_model` envelope style of this project.
 */
export interface SunoModelApiEntry {
  id: string;
  label: string;
  tier: SunoModelTier;
  description: string;
  default_for: CreateSurface[];
  supports_sound: boolean;
}

export function serializeSunoModel(model: SunoModelInfo): SunoModelApiEntry {
  return {
    id: model.id,
    label: model.label,
    tier: model.tier,
    description: model.description,
    default_for: [...model.defaultFor],
    supports_sound: model.supportsSound
  };
}

/** Catalog in wire shape. */
export function listSunoModels(): SunoModelApiEntry[] {
  return SUNO_MODELS.map(serializeSunoModel);
}
