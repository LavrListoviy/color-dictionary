import {
  normalizeHex, hexToRgb, indexCatalog, filterPalettes,
  pickRandom, rankPalettes, describePalette,
} from './color-engine.js';

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const storageKey = 'color-dictionary:favorites:v1';
const state = {
  palettes: [], catalog: null, view: 'random', volume: 'all', size: 'all',
  current: null, favorites: new Set(), secondEnabled: false, lastInputs: null,
  selectedMatchId: null, resultLimit: 9, favoriteLimit: 18,
};
let toastTimeout;

/** Show a short accessible confirmation without interrupting the current action. */
function toast(message) {
  clearTimeout(toastTimeout);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, 3200);
}

function readFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Persist favorites when browser storage is available; retain the session otherwise. */
function toggleFavorite(id) {
  const removing = state.favorites.has(id);
  const focusedButton = document.activeElement;
  const cards = [...document.querySelectorAll('#favorites-content .palette-mini')];
  const focusedIndex = cards.findIndex((card) => card.contains(focusedButton));
  if (removing) state.favorites.delete(id);
  else state.favorites.add(id);
  let persisted = true;
  try { localStorage.setItem(storageKey, JSON.stringify([...state.favorites])); }
  catch { persisted = false; }
  updateFavoriteButtons();
  if (state.view === 'favorites') {
    renderFavorites();
    if (focusedIndex >= 0) {
      const remaining = [...document.querySelectorAll('#favorites-content .palette-mini')];
      const next = remaining[Math.min(focusedIndex, remaining.length - 1)];
      (next?.querySelector('[data-favorite]') ?? $('#tab-favorites')).focus();
    }
  }
  updateFilterCount();
  toast(persisted
    ? removing ? 'Палитра убрана из избранного' : 'Палитра сохранена в избранном'
    : 'Избранное доступно в этой вкладке. Браузер запретил сохранение.');
}

function updateFavoriteButtons() {
  $('#favorite-count').textContent = state.favorites.size;
  document.querySelectorAll('[data-favorite]').forEach((button) => {
    const saved = state.favorites.has(button.dataset.favorite);
    button.setAttribute('aria-pressed', String(saved));
    button.setAttribute('aria-label', saved ? 'Убрать палитру из избранного' : 'Сохранить палитру в избранное');
    button.textContent = saved ? '♥' : '♡';
  });
}

/** Use a readable foreground selected from the actual relative luminance of a swatch. */
function swatchInk(hex) {
  const rgb = hexToRgb(hex);
  const channels = [rgb.r, rgb.g, rgb.b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

function paletteLabel(palette) {
  return `Том ${palette.volume === 1 ? 'I' : 'II'} · № ${String(palette.number).padStart(3, '0')}`;
}

function colorCountLabel(count) {
  return `${count} ${count >= 2 && count <= 4 ? 'цвета' : 'цветов'}`;
}

function paletteCountLabel(count) {
  const lastTwo = count % 100;
  const last = count % 10;
  const word = lastTwo >= 11 && lastTwo <= 14 ? 'сочетаний'
    : last === 1 ? 'сочетание' : last >= 2 && last <= 4 ? 'сочетания' : 'сочетаний';
  return `${count} ${word}`;
}

function favoriteButton(palette) {
  const saved = state.favorites.has(palette.id);
  return `<button type="button" class="favorite-button" data-favorite="${escapeHtml(palette.id)}" aria-pressed="${saved}" aria-label="${saved ? 'Убрать палитру из избранного' : 'Сохранить палитру в избранное'}">${saved ? '♥' : '♡'}</button>`;
}

function quality(entry) {
  if (entry.maxDistance < 0.001) return 'Точное совпадение';
  if (entry.maxDistance < 4) return 'Очень близкие оттенки';
  if (entry.maxDistance < 10) return 'Близкие оттенки';
  return 'Ближайшее из доступного';
}

/** Render a book palette unchanged; input anchors are displayed separately for comparison. */
function featureMarkup(palette, entry = null) {
  const story = describePalette(palette);
  const colors = palette.colors;
  const swatches = colors.map((color, index) => `<button type="button" class="swatch" style="--swatch:${color.hex};--swatch-ink:${swatchInk(color.hex)}" data-copy="${color.hex}" aria-label="Скопировать ${escapeHtml(color.name)}, ${color.hex}"><span class="swatch-copy" aria-hidden="true">Копировать ↗</span><span class="swatch-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span><span class="swatch-code">${color.hex}</span></button>`).join('');
  const labels = colors.map((color) => `<div class="color-label"><span class="color-name">${escapeHtml(color.name)}</span><button class="hex-copy" type="button" data-copy="${color.hex}" aria-label="Скопировать HEX ${color.hex}">${color.hex} <span aria-hidden="true">↗</span></button></div>`).join('');
  const anchors = entry ? `<div class="anchor-matches"><span>${quality(entry)}:</span>${entry.matches.map((match) => `<span class="anchor-match" title="Ваш оттенок → ближайший оттенок палитры"><i class="small-swatch" style="--swatch:${match.inputHex}"></i>${match.inputHex}<span aria-hidden="true">→</span><i class="small-swatch" style="--swatch:${match.color.hex}"></i>${match.color.hex}</span>`).join('')}</div>` : '';
  return `<article class="palette-feature${colors.length > 4 ? ' many-colors' : ''}" aria-label="${paletteLabel(palette)}" style="--color-count:${colors.length}">
    <div class="palette-ribbon"><span class="palette-number">${paletteLabel(palette)}<span class="number-index">/ ${colorCountLabel(colors.length)}</span></span><span>САНЗО ВАДА</span></div>
    <div class="palette-swatches">${swatches}</div><div class="palette-color-labels">${labels}</div>${anchors}
    <div class="palette-story"><div class="story-text"><h2>${escapeHtml(story.title)}</h2><p>${escapeHtml(story.description)}</p><div class="story-tags">${story.tags.map((tag) => `<span class="story-tag">${escapeHtml(tag)}</span>`).join('')}</div></div><div class="palette-actions">${favoriteButton(palette)}<button type="button" class="copy-all" data-copy-palette="${escapeHtml(palette.id)}">Копировать палитру ↗</button></div></div>
  </article>`;
}

function miniMarkup(palette, entry = null) {
  const story = describePalette(palette);
  return `<article class="palette-mini" aria-label="${paletteLabel(palette)}"><div class="mini-swatches" aria-hidden="true">${palette.colors.map((color) => `<span style="--swatch:${color.hex}"></span>`).join('')}</div><div class="mini-topline"><div class="mini-title">${paletteLabel(palette)}<span>${colorCountLabel(palette.colors.length)}</span></div>${favoriteButton(palette)}</div><p class="mini-description">${escapeHtml(story.title)}</p><div class="mini-footer"><button type="button" class="open-palette" data-open="${escapeHtml(palette.id)}">Рассмотреть палитру ↗</button>${entry ? `<span class="match-quality">${quality(entry)}</span>` : ''}</div></article>`;
}

function emptyMarkup(title, text, reset = false) {
  return `<div class="empty-state"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${reset ? '<button type="button" class="load-more" data-reset-filters>Сбросить фильтры</button>' : ''}</div>`;
}

function availablePalettes(favoritesOnly = false) {
  return filterPalettes(state.palettes, {
    volume: state.volume, size: state.size, favoritesOnly, favorites: state.favorites,
  });
}

function updateFilterCount() {
  const count = availablePalettes(state.view === 'favorites').length;
  $('#filter-count').textContent = `${count} в выборке`;
}

function renderRandom() {
  const available = availablePalettes();
  if (!state.current || !available.some((palette) => palette.id === state.current.id)) {
    state.current = pickRandom(available, state.current?.id);
  }
  $('#random-button').disabled = available.length === 0;
  $('#random-content').innerHTML = state.current
    ? featureMarkup(state.current) + '<p class="palette-footnote">Нажмите на цвет, чтобы скопировать HEX. Пояснение — авторская интерпретация свойств палитры.</p>'
    : emptyMarkup('Такого сочетания нет.', 'Попробуйте другой том или другое число оттенков.', true);
  $('#result-status').textContent = state.current ? `Показана палитра: ${paletteLabel(state.current)}.` : 'По выбранным фильтрам палитр нет.';
}

function renderMatch() {
  const host = $('#match-content');
  if (!state.lastInputs) {
    host.innerHTML = '';
    return;
  }
  const ranked = rankPalettes(availablePalettes(), state.lastInputs);
  if (!ranked.length) {
    host.innerHTML = emptyMarkup('Нет палитр с такими фильтрами.', 'Сбросьте фильтры, чтобы искать по всей коллекции.', true);
    $('#result-status').textContent = 'По выбранным фильтрам палитр нет.';
    return;
  }
  const selected = ranked.find((entry) => entry.palette.id === state.selectedMatchId) ?? ranked[0];
  state.selectedMatchId = selected.palette.id;
  $('#result-status').textContent = `Найдено сочетаний: ${ranked.length}. Показана палитра: ${paletteLabel(selected.palette)}. ${quality(selected)}.`;
  const alternatives = ranked.filter((entry) => entry !== selected);
  host.innerHTML = `<div class="results-title"><span>Подбор для ${state.lastInputs.join(' и ')}</span><span>${paletteCountLabel(ranked.length)}</span></div>${featureMarkup(selected.palette, selected)}<p class="palette-footnote">Выбраны ближайшие оттенки из книги. Палитры упорядочены по общему сходству с вашими цветами; для пары учитываются два разных образца.</p><div class="palette-grid">${alternatives.slice(0, state.resultLimit).map((entry) => miniMarkup(entry.palette, entry)).join('')}</div>${alternatives.length > state.resultLimit ? '<button type="button" class="load-more" data-load-results>Ещё сочетания ↓</button>' : ''}`;
}

function renderFavorites() {
  const available = availablePalettes(true);
  $('#favorites-content').innerHTML = available.length
    ? `<div class="palette-grid">${available.slice(0, state.favoriteLimit).map((palette) => miniMarkup(palette)).join('')}</div>${available.length > state.favoriteLimit ? '<button type="button" class="load-more" data-load-favorites>Показать ещё ↓</button>' : ''}`
    : state.favorites.size
      ? emptyMarkup('Избранное не попало в выборку.', 'Измените фильтры, чтобы увидеть сохранённые сочетания.', true)
      : emptyMarkup('Пока ни одного фаворита.', 'Нажмите на сердечко у понравившегося сочетания — оно останется здесь.');
}

/** Keep tab selection, keyboard navigation and the visible panel in sync. */
function setView(view, focus = false) {
  state.view = view;
  document.querySelectorAll('[data-view]').forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(`#panel-${tab.dataset.view}`).hidden = !active;
    if (active && focus) tab.focus();
  });
  renderActive();
}

function renderActive() {
  updateFilterCount();
  if (state.view === 'random') renderRandom();
  else if (state.view === 'match') renderMatch();
  else renderFavorites();
}

function resetFilters() {
  state.volume = 'all';
  state.size = 'all';
  $('#volume-filter').value = 'all';
  $('#size-filter').value = 'all';
  state.selectedMatchId = null;
  state.resultLimit = 9;
  renderActive();
}

function validateInput(name, report = true) {
  const input = $(`#${name}-hex`);
  const hex = normalizeHex(input.value);
  if (report) {
    input.setAttribute('aria-invalid', String(!hex));
    $(`#${name}-error`).textContent = hex ? '' : 'Нужен HEX: например #F80 или #FF8800.';
  }
  if (hex) $(`#${name}-picker`).value = hex;
  return hex;
}

function setSecondEnabled(enabled) {
  state.secondEnabled = enabled;
  $('#second-field').hidden = !enabled;
  $('#add-second').hidden = enabled;
  state.lastInputs = null;
  state.selectedMatchId = null;
  renderMatch();
  if (enabled) $('#second-hex').focus();
  else $('#add-second').focus();
}

/** Copy on HTTPS/localhost; use a selection fallback for browsers denying Clipboard API. */
async function copyText(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
  } catch {
    const previousFocus = document.activeElement;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;top:0;left:-9999px';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    previousFocus?.focus();
    if (!copied) {
      toast(`Не удалось скопировать. Значения: ${text}`);
      return;
    }
  }
  toast(text.includes(',') ? 'Все HEX-коды палитры скопированы' : `${text} скопирован`);
}

/** Initialize from the local dataset; there are no runtime calls to source websites. */
async function initialize() {
  try {
    const response = await fetch(new URL('../data/catalog.json', import.meta.url));
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
    state.catalog = await response.json();
    state.palettes = indexCatalog(state.catalog);
    if (!state.palettes.length) throw new Error('Catalog is empty');
    const knownIds = new Set(state.palettes.map((palette) => palette.id));
    state.favorites = new Set([...readFavorites()].filter((id) => knownIds.has(id)));
    const volumes = state.catalog.volumes;
    $('#catalog-stat').textContent = `${paletteCountLabel(state.palettes.length)} · ${volumes.filter((volume) => volume.available).length} тома`;
    $('#footer-count').textContent = paletteCountLabel(state.palettes.length);
    $('#volume-filter').innerHTML = '<option value="all">Оба тома</option>' + volumes.map((volume) => `<option value="${volume.id}" ${volume.available ? '' : 'disabled'}>${escapeHtml(volume.title)} · ${volume.count}</option>`).join('');
    const sizes = [...new Set(state.palettes.map((palette) => palette.colors.length))].sort((a, b) => a - b);
    $('#size-filter').innerHTML = '<option value="all">Любое число</option>' + sizes.map((size) => `<option value="${size}">${size}</option>`).join('');
    $('#source-details').innerHTML = volumes.map((volume) => `<p class="data-note"><strong>${escapeHtml(volume.title)} · ${paletteCountLabel(volume.count)}.</strong><br>${escapeHtml(volume.note ?? '')}</p>`).join('') + state.catalog.sources.map((source) => {
      const url = new URL(source.url);
      if (url.protocol !== 'https:') return '';
      return `<p><a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)} ↗</a></p>`;
    }).join('');
    $('#load-state').hidden = true;
    $('#app-workspace').setAttribute('aria-busy', 'false');
    $('#find-button').disabled = false;
    state.current = pickRandom(state.palettes.filter((palette) => palette.colors.length === 3), null);
    updateFavoriteButtons();
    renderActive();
  } catch {
    $('#app-workspace').setAttribute('aria-busy', 'false');
    $('#catalog-stat').textContent = 'Коллекция недоступна';
    $('#load-state').className = 'load-error';
    $('#load-state').innerHTML = 'Не удалось загрузить коллекцию. Запустите приложение через npm start или откройте опубликованный сайт.<br><button type="button" class="load-more" data-retry>Попробовать ещё раз</button>';
  }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) setView(button.dataset.view);
  else if (button.hasAttribute('data-favorite')) toggleFavorite(button.dataset.favorite);
  else if (button.dataset.copy) void copyText(button.dataset.copy);
  else if (button.dataset.copyPalette) {
    const palette = state.palettes.find((item) => item.id === button.dataset.copyPalette);
    if (palette) void copyText(palette.colors.map((color) => color.hex).join(', '));
  } else if (button.dataset.open) {
    if (state.view === 'match') {
      state.selectedMatchId = button.dataset.open;
      renderMatch();
      $('#match-content').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#match-content .swatch')?.focus({ preventScroll: true });
    } else {
      state.current = state.palettes.find((palette) => palette.id === button.dataset.open);
      setView('random');
      $('#panel-random').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#random-content .swatch')?.focus({ preventScroll: true });
    }
  } else if (button.hasAttribute('data-reset-filters')) resetFilters();
  else if (button.hasAttribute('data-load-results')) {
    const count = state.resultLimit;
    state.resultLimit += 12;
    renderMatch();
    $('#match-content .palette-grid')?.children[count]?.querySelector('button')?.focus({ preventScroll: true });
  } else if (button.hasAttribute('data-load-favorites')) {
    const count = state.favoriteLimit;
    state.favoriteLimit += 18;
    renderFavorites();
    $('#favorites-content .palette-grid')?.children[count]?.querySelector('button')?.focus({ preventScroll: true });
  } else if (button.hasAttribute('data-retry')) {
    $('#load-state').textContent = 'Загружаем коллекцию…';
    void initialize();
  }
});

$('.view-tabs').addEventListener('keydown', (event) => {
  const views = ['random', 'match', 'favorites'];
  let index = views.indexOf(state.view);
  if (event.key === 'ArrowRight') index = (index + 1) % views.length;
  else if (event.key === 'ArrowLeft') index = (index + views.length - 1) % views.length;
  else if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = views.length - 1;
  else return;
  event.preventDefault();
  setView(views[index], true);
});

$('#random-button').addEventListener('click', () => {
  state.current = pickRandom(availablePalettes(), state.current?.id);
  renderRandom();
});

for (const name of ['volume', 'size']) {
  $(`#${name}-filter`).addEventListener('change', (event) => {
    state[name] = event.target.value;
    state.selectedMatchId = null;
    state.resultLimit = 9;
    state.favoriteLimit = 18;
    renderActive();
  });
}

for (const name of ['first', 'second']) {
  $(`#${name}-picker`).addEventListener('input', (event) => {
    $(`#${name}-hex`).value = event.target.value.toUpperCase();
    validateInput(name);
  });
  $(`#${name}-hex`).addEventListener('input', () => validateInput(name, false));
  $(`#${name}-hex`).addEventListener('blur', () => validateInput(name));
}

$('#add-second').addEventListener('click', () => setSecondEnabled(true));
$('#remove-second').addEventListener('click', () => setSecondEnabled(false));
$('#match-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const first = validateInput('first');
  const second = state.secondEnabled ? validateInput('second') : null;
  if (!first || (state.secondEnabled && !second)) {
    $(!first ? '#first-hex' : '#second-hex').focus();
    return;
  }
  $('#first-hex').value = first;
  if (second) $('#second-hex').value = second;
  state.lastInputs = second ? [first, second] : [first];
  state.selectedMatchId = null;
  state.resultLimit = 9;
  renderMatch();
});

$('#about-button').addEventListener('click', () => $('#about-dialog').showModal());
$('#close-about').addEventListener('click', () => $('#about-dialog').close());
$('#about-dialog').addEventListener('click', (event) => {
  if (event.target !== $('#about-dialog')) return;
  const bounds = event.target.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close();
});

window.addEventListener('storage', (event) => {
  if (event.key !== storageKey && event.key !== null) return;
  const knownIds = new Set(state.palettes.map((palette) => palette.id));
  state.favorites = new Set([...readFavorites()].filter((id) => knownIds.has(id)));
  updateFavoriteButtons();
  if (state.view === 'favorites') renderFavorites();
  updateFilterCount();
});

void initialize();
