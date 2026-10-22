import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indexCatalog, rankPalettes, filterPalettes } from '../src/color-engine.js';

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../data/source-manifest.json', import.meta.url), 'utf8'));
const indexed = indexCatalog(catalog);
const colorsById = new Map(catalog.colors.map((color) => [color.id, color]));

function assertNonemptyText(value, label) {
  assert.equal(typeof value, 'string', `${label} must be text`);
  assert.ok(value.trim().length > 0, `${label} must not be empty`);
}

test('published catalog has both complete, uniquely numbered imported collections', () => {
  assert.equal(catalog.colors.length, 173);
  assert.equal(catalog.palettes.length, 581);
  assert.equal(indexed.length, 581);
  assert.equal(new Set(catalog.palettes.map((palette) => palette.id)).size, 581);
  assert.deepEqual(catalog.volumes.map((volume) => volume.id).sort(), [1, 2]);

  for (const [volume, expectedCount] of [[1, 348], [2, 233]]) {
    const palettes = catalog.palettes.filter((palette) => palette.volume === volume);
    assert.equal(palettes.length, expectedCount);
    assert.deepEqual(
      palettes.map((palette) => palette.number).sort((a, b) => a - b),
      Array.from({ length: expectedCount }, (_, index) => index + 1),
    );
    for (const palette of palettes) {
      assert.equal(palette.id, `v${volume}-${String(palette.number).padStart(3, '0')}`);
    }
  }
});

test('every color has a unique identifier, usable name and valid numeric swatch data', () => {
  assert.equal(colorsById.size, catalog.colors.length);
  const usedColorIds = new Set(catalog.palettes.flatMap((palette) => palette.colorIds));
  assert.equal(usedColorIds.size, catalog.colors.length, 'Unrelated source collections must not leak into the catalog');
  for (const color of catalog.colors) {
    assertNonemptyText(color.id, 'Color id');
    assertNonemptyText(color.name, `Color ${color.id} name`);
    assert.match(color.hex, /^#[0-9a-f]{6}$/i, `Color ${color.id} HEX`);
    if (Object.hasOwn(color, 'cmyk')) {
      assert.ok(Array.isArray(color.cmyk), `Color ${color.id} CMYK must be an array`);
      assert.equal(color.cmyk.length, 4);
      assert.ok(color.cmyk.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 100), `Color ${color.id} CMYK range`);
    }
  }
  assert.equal(colorsById.get('dull-violet-black').hex, '#1e0e3f');
  assert.ok(!Object.hasOwn(colorsById.get('dull-violet-black'), 'cmyk'), 'Invalid upstream 106% channel must not be published as valid CMYK');
});

test('palette references and sizes retain the actual range of each collection', () => {
  for (const palette of catalog.palettes) {
    assert.ok([1, 2].includes(palette.volume), `Unknown volume for ${palette.id}`);
    assert.ok(Number.isInteger(palette.number) && palette.number > 0);
    assert.ok(Array.isArray(palette.colorIds));
    assert.equal(new Set(palette.colorIds).size, palette.colorIds.length, `Repeated swatch in ${palette.id}`);
    for (const id of palette.colorIds) assert.ok(colorsById.has(id), `Unknown color ${id} in ${palette.id}`);
    const size = palette.colorIds.length;
    assert.ok(size >= 2 && size <= (palette.volume === 1 ? 4 : 9), `Invalid size for ${palette.id}`);
    if (palette.volume === 2 && palette.number <= 72) {
      assert.ok(size >= 3 && size <= 7, `Invalid seasonal size for ${palette.id}`);
    }
  }
  assert.deepEqual(
    filterPalettes(indexed, { volume: 2, size: 9 }).map((palette) => palette.id),
    ['v2-152', 'v2-154'],
  );
});

test('source and volume metadata make every imported record traceable', () => {
  const sourceIds = new Set(catalog.sources.map((source) => source.id));
  assert.equal(sourceIds.size, catalog.sources.length);
  assert.deepEqual(sourceIds, new Set(['mattdesl', 'wada-ink']));
  for (const source of catalog.sources) {
    for (const key of ['id', 'title', 'url', 'note']) assertNonemptyText(source[key], `Source ${source.id} ${key}`);
    assert.equal(new URL(source.url).protocol, 'https:');
  }
  for (const palette of catalog.palettes) {
    assert.ok(sourceIds.has(palette.sourceId), `Unknown source in ${palette.id}`);
    assert.equal(palette.sourceId, palette.volume === 1 ? 'mattdesl' : 'wada-ink');
  }
  for (const volume of catalog.volumes) {
    assertNonemptyText(volume.title, `Volume ${volume.id} title`);
    assertNonemptyText(volume.note, `Volume ${volume.id} note`);
    assert.equal(volume.available, true);
    assert.equal(volume.count, catalog.palettes.filter((palette) => palette.volume === volume.id).length);
  }
  assert.ok(Number.isFinite(Date.parse(manifest.importedAt)));
  assert.deepEqual(manifest.records, { colors: 173, palettes: 581, volume1: 348, volume2: 233 });
  assert.deepEqual(new Set(manifest.sources.map((source) => source.id)), sourceIds);
  for (const source of manifest.sources) {
    assert.equal(new URL(source.url).protocol, 'https:');
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
  }
});

test('representative combinations retain source membership, names and screen values', () => {
  const examples = [
    ['v1-001', [
      ['English Red', '#d96629'], ['Cerulian Blue', '#0093a5'],
    ]],
    ['v2-001', [
      ['White', '#ffffff'], ['Sulphur Yellow', '#f5ecc2'], ['Seashell Pink', '#fdd4bd'],
      ['Glaucous Green', '#b4cdc2'], ['Grayish Lavender - B', '#c0a9b3'],
    ]],
    ['v2-020', [
      ['Yellow', '#fff200'], ['Turquoise Green', '#b5decc'], ['Hermosa Pink', '#f9c1ce'],
      ['Cobalt Green', '#96d1aa'], ['Calamine BLue', '#78cdd0'],
    ]],
    ['v2-039', [
      ['Grayish Lavender - B', '#c0a9b3'], ['Lilac', '#b984af'], ['Orange Rufous', '#c16b27'],
      ['Blue Violet', '#6450a1'], ['Violet Blue', '#40456a'],
    ]],
  ];
  for (const [id, expected] of examples) {
    const palette = indexed.find((entry) => entry.id === id);
    assert.ok(palette, `Missing reference palette ${id}`);
    assert.deepEqual(
      new Set(palette.colors.map((color) => `${color.name}:${color.hex.toLowerCase()}`)),
      new Set(expected.map(([name, hex]) => `${name}:${hex}`)),
      `Source membership changed for ${id}`,
    );
  }
});

test('matching a real nine-color palette considers its eighth and ninth swatches', () => {
  const palette = indexed.find((entry) => entry.id === 'v2-152');
  assert.equal(palette.colors.length, 9);
  assert.deepEqual(palette.colors.slice(-2).map((color) => color.hex), ['#064F6E', '#004F46']);
  const inputs = palette.colors.slice(-2).map((color) => color.hex);
  const ranked = rankPalettes(indexed, inputs);
  assert.equal(ranked.length, catalog.palettes.length);
  const result = ranked.find((entry) => entry.palette.id === palette.id);
  assert.ok(result, 'Nine-color palette must participate in matching');
  assert.equal(result.distance, 0);
  assert.equal(result.maxDistance, 0);
  assert.deepEqual(result.matches.map((match) => match.index), [7, 8]);
  assert.deepEqual(result.matches.map((match) => match.color.hex), inputs);
  assert.equal(result.palette.colors.length, 9, 'Matching must preserve the complete source palette');
});
