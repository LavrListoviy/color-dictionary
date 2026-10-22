import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexCatalog } from '../src/color-engine.js';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const catalog = JSON.parse(await readFile(path.join(root, 'data/catalog.json'), 'utf8'));
const palettes = indexCatalog(catalog);
if (!palettes.length || !catalog.volumes?.every((volume) => (
  palettes.filter((palette) => palette.volume === volume.id).length === volume.count
))) throw new Error('Catalog counts do not match the volume metadata.');

const destination = path.join(root, 'dist');
if (path.dirname(destination) !== root || path.basename(destination) !== 'dist') {
  throw new Error('Build output must stay inside the project dist directory.');
}
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const entry of ['index.html', 'src', 'data', 'assets', '.nojekyll', 'THIRD_PARTY_NOTICES.txt']) {
  await cp(path.join(root, entry), path.join(destination, entry), { recursive: true });
}
console.log(`Built ${palettes.length} palettes into dist/.`);
