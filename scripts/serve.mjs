import http from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const argument = process.argv.find((item) => item.startsWith('--port='));
const port = Number(argument?.split('=')[1] ?? process.env.PORT ?? 4173);
const directory = process.argv.includes('--dist') ? path.join(root, 'dist') : root;
const prefixArgument = process.argv.find((item) => item.startsWith('--base='));
const prefix = prefixArgument ? `/${prefixArgument.slice(7).replace(/^\/+|\/+$/g, '')}/` : '/';
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };

/** Serve the static app at / or a repository-style prefix for GitHub Pages checks. */
const server = http.createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Method not allowed');
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (prefix !== '/' && pathname === prefix.slice(0, -1)) {
      response.writeHead(302, { Location: prefix });
      response.end();
      return;
    }
    if (!pathname.startsWith(prefix)) throw new Error('Not found');
    const relative = pathname.slice(prefix.length) || 'index.html';
    const target = path.resolve(directory, relative);
    if (!target.startsWith(directory + path.sep) || relative.split(/[\\/]/).some((part) => part.startsWith('.'))) throw new Error('Not found');
    const allowedRoots = ['src', 'data', 'assets'];
    if (!['index.html', 'THIRD_PARTY_NOTICES.txt'].includes(relative) && !allowedRoots.includes(relative.split('/')[0])) throw new Error('Not found');
    if (!(await stat(target)).isFile()) throw new Error('Not found');
    const content = await readFile(target);
    response.writeHead(200, { 'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${server.address().port}${prefix}`));
