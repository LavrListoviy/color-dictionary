/** Normalize a three- or six-digit sRGB HEX value, rejecting other CSS syntax. */
export function normalizeHex(value) {
  if (typeof value !== 'string') return null;

  const digits = value.trim().replace(/^#/, '');
  if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(digits)) return null;

  const expanded = digits.length === 3
    ? [...digits].map((digit) => digit + digit).join('')
    : digits;
  return `#${expanded.toUpperCase()}`;
}

/** Convert HEX to integer sRGB channels in the range 0–255. */
export function hexToRgb(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;

  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function linearize(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/**
 * Convert sRGB HEX to Oklab using Björn Ottosson's January 2021 matrices.
 * L is approximately 0–1; a and b are unscaled opponent coordinates.
 * Reference: https://bottosson.github.io/posts/oklab/
 */
export function hexToOklab(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;

  const r = linearize(rgb.r);
  const g = linearize(rgb.g);
  const b = linearize(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function resolveLab(value) {
  if (typeof value === 'string') return hexToOklab(value);
  if (value && ['L', 'a', 'b'].every((key) => Number.isFinite(value[key]))) return value;
  return null;
}

/** Return Euclidean Oklab distance ×100 for HEX strings or {L, a, b} values. */
export function colorDistance(first, second) {
  const a = resolveLab(first);
  const b = resolveLab(second);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b) * 100;
}

/**
 * Resolve catalog references and cache Oklab coordinates without mutating input.
 * Invalid references are rejected so catalog mistakes cannot silently lose colors.
 */
export function indexCatalog(catalog) {
  if (!Array.isArray(catalog?.colors) || !Array.isArray(catalog?.palettes)) {
    throw new TypeError('Catalog must contain colors and palettes arrays.');
  }

  const colors = new Map();
  for (const color of catalog.colors) {
    const hex = normalizeHex(color.hex);
    if (!color.id || !hex || colors.has(color.id)) {
      throw new TypeError(`Invalid or duplicate catalog color: ${color.id ?? '(missing id)'}`);
    }
    colors.set(color.id, { ...color, hex, lab: hexToOklab(hex) });
  }

  return catalog.palettes.map((palette) => {
    if (!Array.isArray(palette.colorIds) || palette.colorIds.length === 0) {
      throw new TypeError(`Palette ${palette.id} must reference at least one color.`);
    }
    return {
      ...palette,
      colorIds: [...palette.colorIds],
      colors: palette.colorIds.map((id) => {
        if (!colors.has(id)) throw new TypeError(`Palette ${palette.id} references unknown color ${id}.`);
        return colors.get(id);
      }),
    };
  });
}

function comparePaletteOrder(first, second) {
  return Number(first.volume) - Number(second.volume)
    || Number(first.number) - Number(second.number)
    || String(first.id).localeCompare(String(second.id), 'en');
}

function compareScores(first, second) {
  return first.distance - second.distance || first.maxDistance - second.maxDistance;
}

/**
 * Rank palettes by their best one-to-one assignment to one or two input colors.
 * A pair always uses distinct swatch positions, including identical input colors.
 * Scores are average distances; ties favor lower worst distance, volume and number.
 */
export function rankPalettes(palettes, inputHexes) {
  if (!Array.isArray(inputHexes) || inputHexes.length < 1 || inputHexes.length > 2) {
    throw new RangeError('Provide one or two input colors.');
  }
  const inputs = inputHexes.map((input) => {
    const hex = normalizeHex(input);
    if (!hex) throw new TypeError(`Invalid input HEX: ${input}`);
    return { hex, lab: hexToOklab(hex) };
  });

  const ranked = [];
  for (const palette of palettes) {
    if (!Array.isArray(palette.colors) || palette.colors.length < inputs.length) continue;

    const distances = inputs.map((input) => palette.colors.map((color) => (
      colorDistance(input.lab, color.lab ?? color.hex)
    )));
    let best = null;

    for (let first = 0; first < palette.colors.length; first += 1) {
      const secondOptions = inputs.length === 1
        ? [null]
        : palette.colors.map((_, index) => index).filter((index) => index !== first);

      for (const second of secondOptions) {
        const positions = inputs.length === 1 ? [first] : [first, second];
        const matches = positions.map((index, inputIndex) => ({
          inputHex: inputs[inputIndex].hex,
          color: palette.colors[index],
          index,
          distance: distances[inputIndex][index],
        }));
        const candidate = {
          palette,
          matches,
          distance: matches.reduce((sum, match) => sum + match.distance, 0) / inputs.length,
          maxDistance: Math.max(...matches.map((match) => match.distance)),
        };
        if (!best || compareScores(candidate, best) < 0) best = candidate;
      }
    }

    if (best && Number.isFinite(best.distance)) ranked.push(best);
  }

  return ranked.sort((first, second) => (
    compareScores(first, second) || comparePaletteOrder(first.palette, second.palette)
  ));
}

/** Filter indexed palettes by volume, swatch count and a Set of favorite IDs. */
export function filterPalettes(palettes, {
  volume = 'all',
  size = 'all',
  favoritesOnly = false,
  favorites = new Set(),
} = {}) {
  return palettes.filter((palette) => (
    (volume === 'all' || String(palette.volume) === String(volume))
    && (size === 'all' || (palette.colors?.length ?? palette.colorIds?.length) === Number(size))
    && (!favoritesOnly || favorites.has(palette.id))
  ));
}

/** Pick uniformly from the available palettes, avoiding the previous ID if possible. */
export function pickRandom(palettes, currentId, randomFn = Math.random) {
  if (palettes.length === 0) return null;
  const alternatives = palettes.filter((palette) => palette.id !== currentId);
  const candidates = alternatives.length > 0 ? alternatives : palettes;
  const value = Number(randomFn());
  const fraction = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
  return candidates[Math.min(Math.floor(fraction * candidates.length), candidates.length - 1)];
}

/**
 * Write an original Russian reading of the measured colors, not a historical claim.
 * Returns {title, description, tags}; thresholds are editorial heuristics in Oklab.
 */
export function describePalette(palette) {
  const colors = (palette.colors ?? [])
    .map((color) => ({ ...color, lab: color.lab ?? hexToOklab(color.hex) }))
    .filter((color) => color.lab);
  if (colors.length === 0) {
    return { title: 'Палитра без оттенков', description: 'Для описания нужны цветовые образцы.', tags: [] };
  }

  const lightness = colors.map((color) => color.lab.L);
  const averageLightness = lightness.reduce((sum, value) => sum + value, 0) / colors.length;
  const spread = Math.max(...lightness) - Math.min(...lightness);
  const chroma = colors.map((color) => Math.hypot(color.lab.a, color.lab.b));
  const averageChroma = chroma.reduce((sum, value) => sum + value, 0) / colors.length;
  let warmWeight = 0;
  let coolWeight = 0;

  colors.forEach((color, index) => {
    if (chroma[index] < 0.035) return;
    const hue = (Math.atan2(color.lab.b, color.lab.a) * 180 / Math.PI + 360) % 360;
    if (hue < 110 || hue >= 340) warmWeight += chroma[index];
    else coolWeight += chroma[index];
  });

  const totalWeight = warmWeight + coolWeight;
  const temperature = totalWeight === 0 ? 'neutral'
    : warmWeight / totalWeight >= 0.75 ? 'warm'
      : coolWeight / totalWeight >= 0.75 ? 'cool' : 'mixed';
  const temperatureWords = {
    neutral: ['Нейтральная', 'нейтральная', 'Ахроматические оттенки держат внимание на светлоте и форме.'],
    warm: ['Тёплая', 'тёплая', 'Преобладают тёплые цветовые ноты.'],
    cool: ['Прохладная', 'прохладная', 'Преобладают прохладные цветовые ноты.'],
    mixed: ['Диалог температур', 'смешанная температура', 'Тёплые и прохладные оттенки уравновешивают друг друга.'],
  };
  const lightnessTag = averageLightness >= 0.75 ? 'светлая' : averageLightness <= 0.45 ? 'тёмная' : 'средняя светлота';
  const chromaTag = averageChroma >= 0.14 ? 'насыщенная' : averageChroma < 0.06 ? 'приглушённая' : 'умеренная насыщенность';
  const contrastTag = spread >= 0.45 ? 'сильный контраст' : spread >= 0.22 ? 'умеренный контраст' : 'близкая светлота';
  const chromaText = averageChroma >= 0.14
    ? 'Насыщенные цвета делают сочетание выразительным.'
    : averageChroma < 0.06
      ? 'Приглушённые оттенки создают спокойный ритм.'
      : 'Умеренная насыщенность оставляет место цветовым акцентам.';
  const contrastText = spread >= 0.45
    ? 'Сильный перепад светлоты помогает разделить фон и акцент.'
    : spread >= 0.22
      ? 'Умеренный перепад светлоты позволяет выстроить мягкую иерархию.'
      : 'Близкая светлота сближает оттенки; различия заметнее в самом цвете.';

  return {
    title: temperature === 'mixed'
      ? temperatureWords[temperature][0]
      : `${temperatureWords[temperature][0]} ${spread >= 0.45 ? 'контрастность' : 'гармония'}`,
    description: `${temperatureWords[temperature][2]} ${chromaText} ${contrastText}`,
    tags: [temperatureWords[temperature][1], lightnessTag, chromaTag, contrastTag],
  };
}
