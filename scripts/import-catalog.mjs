import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrls = {
  volume1: 'https://raw.githubusercontent.com/mattdesl/dictionary-of-colour-combinations/master/colors.json',
  volume2: 'https://wada.ink/palettes',
};

/** Read a supplied source snapshot or download the current public source. */
async function readSource(flag, url) {
  const argument = process.argv.find((value) => value.startsWith(`${flag}=`));
  if (argument) return readFile(argument.slice(flag.length + 1), 'utf8');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Source request failed: ${response.status} ${url}`);
  return response.text();
}

/** Decode attribute entities without evaluating or retaining upstream HTML. */
function decodeAttribute(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#39);/g, (entity) => ({
    '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&#39;': "'",
  })[entity]);
}

function slugify(value) {
  return value.toLowerCase().replace(/\|/g, '-').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Extract only factual records from the public JSON indexes and color links. */
function extractVolume2(html) {
  const readIndex = (id) => {
    const match = html.match(new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)<\\/script>`));
    assert.ok(match, `Missing public JSON index: ${id}`);
    return JSON.parse(match[1]);
  };
  const colors = new Map(readIndex('search-index').map((color) => [color.s, color]));
  const paletteIndex = readIndex('palette-search-index').filter((palette) => palette.v === 2);
  assert.equal(paletteIndex.length, 233, 'Review source changes before accepting a different volume II count');
  const cardStarts = [...html.matchAll(/<div class="cell"[^>]*data-id="(\d+)"[^>]*data-vol="(\d+)"[^>]*>/g)];
  const cards = new Map();
  cardStarts.forEach((match, index) => {
    if (Number(match[2]) !== 2) return;
    const cardSection = html.slice(match.index + match[0].length, cardStarts[index + 1]?.index ?? html.length);
    const section = cardSection.slice(0, cardSection.indexOf('</article>'));
    const number = Number(match[1]) - 2000;
    const colorSlugs = [];
    const found = new Set();
    for (const link of section.matchAll(/<a\b[^>]*href="\/colors\/([^"/]+)"[^>]*>/g)) {
      const slug = decodeAttribute(link[1]);
      if (found.has(slug)) continue;
      found.add(slug);
      const color = colors.get(slug);
      assert.ok(color, `Unknown color ${slug} in volume II palette ${number}`);
      const hex = link[0].match(/--bg:(#[a-f0-9]{6})/i)?.[1].toLowerCase();
      assert.equal(hex, color.h.toLowerCase(), `Conflicting color value for ${slug}`);
      colorSlugs.push(slug);
    }
    cards.set(number, colorSlugs);
  });
  assert.equal(cards.size, 233, 'All volume II cards must be present');
  const usedColors = new Map();
  const palettes = paletteIndex.map((palette, index) => {
    assert.equal(palette.id, index + 1, 'Volume II numbering must remain continuous');
    const slugs = cards.get(palette.id);
    assert.ok(slugs?.length >= 2 && slugs.length <= 9, `Invalid volume II palette ${palette.id}`);
    if (palette.id <= 72) assert.ok(slugs.length >= 3 && slugs.length <= 7, `Invalid seasonal palette ${palette.id}`);
    const actualHex = slugs.map((slug) => colors.get(slug).h.toLowerCase());
    assert.deepEqual(actualHex, palette.hx.map((hex) => hex.toLowerCase()), `Card/index disagreement for volume II palette ${palette.id}`);
    for (const slug of slugs) usedColors.set(slug, colors.get(slug));
    return { number: palette.id, slugs };
  });
  return { colors: usedColors, palettes };
}

/** Merge identical named swatches while preserving distinct printed variants. */
function buildCatalog(volume1Text, volume2Html) {
  const originalColors = JSON.parse(volume1Text);
  assert.equal(originalColors.length, 159);
  const volume2 = extractVolume2(volume2Html);
  const colors = [];
  const colorBySignature = new Map();
  const ids = new Set();
  const addColor = (color) => {
    const hex = color.hex.toLowerCase();
    assert.match(hex, /^#[0-9a-f]{6}$/);
    const normalizedName = slugify(color.name);
    const signature = `${normalizedName}:${hex}`;
    if (colorBySignature.has(signature)) return colorBySignature.get(signature);
    let id = normalizedName;
    if (ids.has(id)) id = `${id}-${hex.slice(1)}`;
    assert.ok(!ids.has(id), `Duplicate color id: ${id}`);
    ids.add(id);
    const record = { id, name: color.name, hex };
    if (color.cmyk) {
      const validCmyk = color.cmyk.length === 4 && color.cmyk.every((value) => Number.isFinite(value) && value >= 0 && value <= 100);
      if (validCmyk) record.cmyk = color.cmyk;
      else {
        assert.equal(color.name, 'Dull Violet Black', `Unexpected invalid source CMYK: ${color.name}`);
        assert.deepEqual(color.cmyk, [95, 106, 38, 50]);
        console.warn('Omitted invalid upstream CMYK [95,106,38,50] for Dull Violet Black; retained source HEX.');
      }
    }
    colors.push(record);
    colorBySignature.set(signature, id);
    return id;
  };
  const volume1Palettes = new Map();
  for (const color of originalColors) {
    const colorId = addColor(color);
    for (const number of color.combinations) {
      if (!volume1Palettes.has(number)) volume1Palettes.set(number, []);
      volume1Palettes.get(number).push(colorId);
    }
  }
  assert.equal(volume1Palettes.size, 348);
  const palettes = [...volume1Palettes.entries()].sort(([a], [b]) => a - b).map(([number, colorIds], index) => {
    assert.equal(number, index + 1);
    assert.ok(colorIds.length >= 2 && colorIds.length <= 4);
    return { id: `v1-${String(number).padStart(3, '0')}`, volume: 1, number, colorIds, sourceId: 'mattdesl' };
  });
  const volume2ColorIds = new Map([...volume2.colors].map(([slug, color]) => [slug, addColor({ name: color.n, hex: color.h, cmyk: color.c })]));
  for (const palette of volume2.palettes) {
    palettes.push({
      id: `v2-${String(palette.number).padStart(3, '0')}`,
      volume: 2,
      number: palette.number,
      colorIds: palette.slugs.map((slug) => volume2ColorIds.get(slug)),
      sourceId: 'wada-ink',
    });
  }
  return {
    sources: [
      { id: 'mattdesl', title: 'Matt DesLauriers · Dictionary of Colour Combinations', url: 'https://github.com/mattdesl/dictionary-of-colour-combinations', note: 'Открытая оцифровка первого тома, MIT. Первоначальные данные: Dain M. Blodorn Kim. Экранные значения — приближение печатных CMYK.' },
      { id: 'wada-ink', title: 'Wada.ink · Allison Peña', url: 'https://wada.ink/palettes', note: '233 палитры второго тома из общедоступного каталога. Перенесены названия, значения цветов и состав сочетаний; авторские описания сайта не используются. С бумажным экземпляром независимо не сверены.' },
    ],
    colors,
    palettes,
    volumes: [
      { id: 1, title: 'Том I', available: true, count: 348, note: '348 сочетаний из открытого набора Matt DesLauriers, основанного на книге Сандзо Вады.' },
      { id: 2, title: 'Том II', available: true, count: 233, note: '233 сочетания по каталогу Wada.ink: сезонные палитры и примеры дизайна. Независимая сверка с печатным изданием не выполнена.' },
    ],
  };
}

const volume1Text = await readSource('--v1-json', sourceUrls.volume1);
const volume2Html = await readSource('--wada-html', sourceUrls.volume2);
const catalog = buildCatalog(volume1Text, volume2Html);
const importedAt = new Date().toISOString();
const fingerprint = (value) => createHash('sha256').update(value).digest('hex');
const manifest = {
  importedAt,
  records: { colors: catalog.colors.length, palettes: catalog.palettes.length, volume1: 348, volume2: 233 },
  sources: [
    { id: 'mattdesl', url: sourceUrls.volume1, sha256: fingerprint(volume1Text) },
    { id: 'wada-ink', url: sourceUrls.volume2, sha256: fingerprint(volume2Html) },
  ],
};
await mkdir(path.join(projectRoot, 'data'), { recursive: true });
await writeFile(path.join(projectRoot, 'data', 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
await writeFile(path.join(projectRoot, 'data', 'source-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Imported ${catalog.palettes.length} palettes (${manifest.records.volume1} + ${manifest.records.volume2}) and ${catalog.colors.length} swatches.`);
