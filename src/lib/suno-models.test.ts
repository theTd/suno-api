import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MODEL,
  findSunoModel,
  listSunoModels,
  SUNO_MODELS
} from './suno-models';
import { parseSoundKey, parseSoundTempo, SOUND_KEY_HINT } from './generation-options';
import { buildGenerateV2Payload } from './SunoApi';

test('model catalog matches the official /create menu (v6, v6-wild, v6-mini)', () => {
  assert.equal(SUNO_MODELS.length, 3);
  assert.deepEqual(
    SUNO_MODELS.map((m) => m.id),
    ['chirp-hawk', 'chirp-hawk-wild', 'chirp-goose']
  );
  assert.deepEqual(
    SUNO_MODELS.map((m) => m.label),
    ['v6', 'v6-wild', 'v6-mini']
  );
  assert.ok(SUNO_MODELS.every((m) => m.supportsSound));
});

test('API default stays chirp-hawk while the catalog records official tab preselection', () => {
  assert.equal(DEFAULT_MODEL, 'chirp-hawk');
  const byId = new Map(SUNO_MODELS.map((m) => [m.id, m]));
  assert.deepEqual(byId.get('chirp-hawk')?.defaultFor, ['simple', 'advanced']);
  assert.deepEqual(byId.get('chirp-goose')?.defaultFor, ['sounds']);
});

test('listSunoModels serves snake_case wire shape matching the docs', () => {
  const models = listSunoModels();
  assert.equal(models.length, 3);
  for (const entry of models) {
    assert.deepEqual(Object.keys(entry).sort(), [
      'default_for',
      'description',
      'id',
      'label',
      'supports_sound',
      'tier'
    ]);
    assert.ok(!('defaultFor' in entry));
    assert.ok(!('supportsSound' in entry));
  }
  assert.equal(models[2].id, 'chirp-goose');
});

test('findSunoModel resolves ids and labels case-insensitively', () => {
  assert.equal(findSunoModel('chirp-goose')?.label, 'v6-mini');
  assert.equal(findSunoModel('V6-WILD')?.id, 'chirp-hawk-wild');
  assert.equal(findSunoModel('unknown-id'), undefined);
  assert.equal(findSunoModel(), undefined);
});

test('parseSoundKey accepts the official Key picker set', () => {
  for (const key of ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'Cm', 'C#m', 'A#m', 'Bm'])
    assert.equal(parseSoundKey(key), key);
  assert.equal(parseSoundKey(undefined), undefined);
  assert.equal(parseSoundKey(''), undefined);
});

test('parseSoundKey rejects keys the official picker cannot produce', () => {
  for (const key of ['E#', 'B#', 'E#m', 'B#m', 'H', 'Cb', 'C##', 'mm'])
    assert.throws(() => parseSoundKey(key), /key must be one of/);
});

test('sound key errors share one hint across REST and MCP', () => {
  assert.match(SOUND_KEY_HINT, /A#.*'m' for minor/);
  assert.throws(() => parseSoundKey('E#'), new RegExp('key must be one of'));
  try {
    parseSoundKey('E#');
    assert.fail('should have thrown');
  } catch (err: any) {
    assert.ok(err.message.includes(SOUND_KEY_HINT));
  }
});

test('parseSoundTempo keeps the 1-300 integer range of the BPM input', () => {
  assert.equal(parseSoundTempo(120), 120);
  assert.equal(parseSoundTempo(undefined), undefined);
  assert.throws(() => parseSoundTempo(0), /tempo must be an integer between 1 and 300/);
  assert.throws(() => parseSoundTempo(301), /tempo must be an integer between 1 and 300/);
  assert.throws(() => parseSoundTempo(1.5), /tempo must be an integer between 1 and 300/);
});

test('sound payload matches the official Sounds request (no sliders, no lyrics model)', () => {
  const payload = buildGenerateV2Payload(
    {
      prompt: 'a soft click',
      isCustom: true,
      tags: 'a soft click',
      title: 'A Soft Click',
      make_instrumental: true,
      model: 'chirp-goose',
      task: 'sound',
      sound_loop: false
    },
    { captchaToken: null, createSessionToken: 'test-session' }
  );
  assert.equal(payload.task, 'sound');
  assert.equal(payload.prompt, '');
  assert.equal(payload.metadata.create_mode, 'custom');
  assert.deepEqual(payload.metadata.sound_configs, { user_loop: false });
  assert.ok(!('control_sliders' in payload.metadata));
  assert.ok(!('lyrics_model' in payload.metadata));
});

test('song payload keeps control sliders and lyrics model', () => {
  const payload = buildGenerateV2Payload(
    { prompt: 'a ballad', isCustom: false, model: 'chirp-hawk' },
    { captchaToken: null, createSessionToken: 'test-session' }
  );
  assert.deepEqual(payload.metadata.control_sliders, { aug_creativity: 1 });
  assert.equal(payload.metadata.lyrics_model, 'default');
  assert.ok(!('task' in payload));
});
