import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHex,
  hexToRgb,
  hexToOklab,
  colorDistance,
  indexCatalog,
  rankPalettes,
  filterPalettes,
  pickRandom,
  describePalette,
} from '../src/color-engine.js';

const catalog = {
  colors: [
    { id: 'red', name: 'Red', hex: '#FF0000' },
    { id: 'near-red', name: 'Near red', hex: '#FA0808' },
    { id: 'blue', name: 'Blue', hex: '#0000FF' },
    { id: 'white', name: 'White', hex: '#FFFFFF' },
    { id: 'black', name: 'Black', hex: '#000000' },
  ],
  palettes: [
    { id: 'v1-001', volume: 1, number: 1, colorIds: ['red', 'white'] },
    { id: 'v1-002', volume: 1, number: 2, colorIds: ['near-red', 'blue', 'black'] },
    { id: 'v2-001', volume: 2, number: 1, colorIds: ['red', 'blue'] },
  ],
};

function almostEqual(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test('HEX normalization expands shorthand and rejects unsupported input', () => {
  assert.equal(normalizeHex('#aBc'), '#AABBCC');
  assert.equal(normalizeHex(' 12abEF '), '#12ABEF');
  assert.equal(normalizeHex('000'), '#000000');
  for (const value of ['', '#', '##123', '#1234', '12345', '1234567', '12GG56', 'red', 'rgb(1, 2, 3)', null, 123]) {
    assert.equal(normalizeHex(value), null, String(value));
  }
});

test('HEX conversion retains integer RGB values and rejects invalid HEX', () => {
  assert.deepEqual(hexToRgb('#1234ab'), { r: 18, g: 52, b: 171 });
  assert.deepEqual(hexToRgb('f80'), { r: 255, g: 136, b: 0 });
  assert.equal(hexToRgb('no color'), null);
  assert.equal(hexToOklab('#oops'), null);
});

test('Oklab matches known sRGB reference values, including a gamma-sensitive gray', () => {
  const references = [
    ['#000000', { L: 0, a: 0, b: 0 }],
    ['#FFFFFF', { L: 0.9999999935, a: 0, b: 0.0000000373 }],
    ['#FF0000', { L: 0.6279553606, a: 0.2248630611, b: 0.1258462985 }],
    ['#00FF00', { L: 0.8664396115, a: -0.2338875742, b: 0.1794984799 }],
    ['#0000FF', { L: 0.4520137184, a: -0.0324569842, b: -0.3115281477 }],
    ['#808080', { L: 0.5998708017, a: 0, b: 0.0000000224 }],
  ];
  for (const [hex, expected] of references) {
    const actual = hexToOklab(hex);
    for (const key of ['L', 'a', 'b']) almostEqual(actual[key], expected[key]);
  }
});

test('perceptual distance is symmetric, scaled by 100 and zero for equal colors', () => {
  assert.equal(colorDistance('#123456', '#123456'), 0);
  almostEqual(colorDistance('#000', '#fff'), 100, 1e-5);
  assert.equal(colorDistance('#f00', '#00f'), colorDistance('#00f', '#f00'));
  assert.equal(colorDistance({ L: 0, a: 0, b: 0 }, { L: 0.3, a: 0.4, b: 0 }), 50);
  assert.equal(colorDistance('invalid', '#000'), Number.POSITIVE_INFINITY);
});

test('catalog indexing resolves references and leaves the source unchanged', () => {
  const original = structuredClone(catalog);
  const indexed = indexCatalog(catalog);
  assert.deepEqual(catalog, original);
  assert.equal(indexed[0].colors[0].id, 'red');
  assert.ok(Number.isFinite(indexed[0].colors[0].lab.L));
  assert.equal(indexed[0].colors[0], indexed[2].colors[0]);
  assert.throws(() => indexCatalog({ colors: catalog.colors, palettes: [{ id: 'bad', colorIds: ['missing'] }] }), /unknown color/);
  assert.throws(() => indexCatalog({ colors: [{ id: 'bad', hex: '#oops' }], palettes: [] }), /Invalid/);
});

test('exact matches precede near matches and ties follow volume and number', () => {
  const indexed = indexCatalog(catalog);
  const ranked = rankPalettes([...indexed].reverse(), ['#f00']);
  assert.deepEqual(ranked.map((entry) => entry.palette.id), ['v1-001', 'v2-001', 'v1-002']);
  assert.equal(ranked[0].distance, 0);
  assert.equal(ranked[0].matches[0].inputHex, '#FF0000');
  assert.ok(ranked[2].distance > 0);
});

test('two input colors select distinct swatches and minimize their joint distance', () => {
  const indexed = indexCatalog(catalog);
  const ranked = rankPalettes(indexed, ['#f00', '#00f']);
  assert.equal(ranked[0].palette.id, 'v2-001');
  assert.equal(ranked[0].distance, 0);
  assert.deepEqual(ranked[0].matches.map((match) => match.color.id), ['red', 'blue']);
  for (const entry of ranked) assert.notEqual(entry.matches[0].index, entry.matches[1].index);

  const identical = rankPalettes([indexed[0]], ['#f00', '#f00'])[0];
  assert.notEqual(identical.matches[0].index, identical.matches[1].index);
  assert.ok(identical.distance > 0, 'one red swatch cannot satisfy two anchors');
});

test('two-anchor assignment considers the global best pair instead of greedy selection', () => {
  const palettes = [{
    id: 'pair', volume: 1, number: 1,
    colors: [
      { id: 'middle', hex: '#808080', lab: { L: 0.5, a: 0, b: 0 } },
      { id: 'dark', hex: '#000000', lab: { L: 0, a: 0, b: 0 } },
    ],
  }];
  const entry = rankPalettes(palettes, ['#666666', '#808080'])[0];
  assert.deepEqual(entry.matches.map((match) => match.color.id), ['dark', 'middle']);
});

test('equal average distance favors a balanced pair before catalog order', () => {
  const palettes = [
    {
      id: 'v1-001', volume: 1, number: 1,
      colors: [
        { id: 'exact', hex: '#000000', lab: { L: 0, a: 0, b: 0 } },
        { id: 'far', hex: '#808080', lab: { L: 0.4, a: 0, b: 0 } },
      ],
    },
    {
      id: 'v2-002', volume: 2, number: 2,
      colors: [
        { id: 'near-a', hex: '#333333', lab: { L: 0.2, a: 0, b: 0 } },
        { id: 'near-b', hex: '#333333', lab: { L: 0.2, a: 0, b: 0 } },
      ],
    },
  ];
  const ranked = rankPalettes(palettes, ['#000', '#000']);
  assert.equal(ranked[0].palette.id, 'v2-002');
  assert.equal(ranked[0].distance, ranked[1].distance);
  assert.ok(ranked[0].maxDistance < ranked[1].maxDistance);

  const repeated = [
    { ...palettes[1], id: 'v2-011', number: 11 },
    { ...palettes[1], id: 'v2-002', number: 2 },
  ];
  assert.deepEqual(rankPalettes(repeated, ['#000']).map((entry) => entry.palette.id), ['v2-002', 'v2-011']);
});

test('anchor order preserves palette ranking and score', () => {
  const indexed = indexCatalog(catalog);
  const forward = rankPalettes(indexed, ['#e34a21', '#354a91']);
  const reverse = rankPalettes(indexed, ['#354a91', '#e34a21']);
  assert.deepEqual(forward.map((entry) => entry.palette.id), reverse.map((entry) => entry.palette.id));
  forward.forEach((entry, index) => {
    almostEqual(entry.distance, reverse[index].distance);
    almostEqual(entry.maxDistance, reverse[index].maxDistance);
    assert.deepEqual(entry.matches.map((match) => match.index), reverse[index].matches.map((match) => match.index).reverse());
  });
});

test('ranker rejects invalid anchor input and excludes undersized palettes', () => {
  const indexed = indexCatalog(catalog);
  assert.throws(() => rankPalettes(indexed, []), RangeError);
  assert.throws(() => rankPalettes(indexed, ['#f00', '#0f0', '#00f']), RangeError);
  assert.throws(() => rankPalettes(indexed, ['nonsense']), TypeError);
  assert.deepEqual(rankPalettes([{ id: 'single', colors: [indexed[0].colors[0]] }], ['#f00', '#00f']), []);
  assert.deepEqual(rankPalettes([], ['#f00']), []);
});

test('filters combine string or numeric volume, size and favorite IDs', () => {
  const indexed = indexCatalog(catalog);
  assert.equal(filterPalettes(indexed).length, 3);
  assert.deepEqual(filterPalettes(indexed, { volume: '1', size: '3' }).map((palette) => palette.id), ['v1-002']);
  assert.deepEqual(filterPalettes(indexed, { volume: 2, size: 2 }).map((palette) => palette.id), ['v2-001']);
  assert.deepEqual(filterPalettes(indexed, { favoritesOnly: true, favorites: new Set(['v1-001', 'v2-001']), volume: 1 }), [indexed[0]]);
  assert.deepEqual(filterPalettes(indexed, { favoritesOnly: true }), []);
  assert.deepEqual(filterPalettes(indexed, { size: 4 }), []);
});

test('random choice avoids immediate repetition and handles empty or single results', () => {
  const indexed = indexCatalog(catalog);
  assert.equal(pickRandom([], null), null);
  assert.equal(pickRandom([indexed[0]], indexed[0].id), indexed[0]);
  assert.equal(pickRandom(indexed, indexed[0].id, () => 0), indexed[1]);
  assert.equal(pickRandom(indexed, indexed[0].id, () => 0.999), indexed[2]);
  assert.equal(pickRandom(indexed, null, () => 1), indexed[2]);
  for (let step = 0; step < 100; step += 1) {
    assert.notEqual(pickRandom(indexed, 'v1-002', () => step / 100).id, 'v1-002');
  }
});

test('original descriptions reflect measured contrast, saturation and temperature', () => {
  const indexed = indexCatalog(catalog);
  const neutral = describePalette({ colors: [indexed[0].colors[1], indexed[1].colors[2]] });
  assert.ok(neutral.tags.includes('сильный контраст'));
  assert.ok(neutral.tags.includes('приглушённая'));
  assert.ok(neutral.tags.includes('нейтральная'));
  const warm = describePalette({ colors: [indexed[0].colors[0], indexed[1].colors[0]] });
  assert.ok(warm.tags.includes('тёплая'));
  assert.ok(warm.tags.includes('насыщенная'));
  assert.ok(warm.tags.includes('близкая светлота'));
  assert.equal(typeof warm.title, 'string');
  assert.ok(warm.description.length > 30);
  assert.deepEqual(describePalette({ colors: [] }).tags, []);
});
