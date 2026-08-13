import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSocialPreviewResponse } from '../functions/_lib/socialPreview.js';
import { registerGracefulShutdown } from './gracefulShutdown.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const INDEX_HTML = join(DIST, 'index.html');

if (!existsSync(DIST)) {
  console.error(`[server] dist/ introuvable (${DIST}). Lance "npm run build" avant "npm start".`);
  process.exit(1);
}

const app = new Hono();

app.use('/*', async (c, next) => {
  await next();
  if (c.res.headers.has('cache-control')) return;
  const path = new URL(c.req.url).pathname;
  const isAssetHit = path.startsWith('/assets/') && c.res.status === 200;
  if (isAssetHit) {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    c.header('Cache-Control', 'no-cache, must-revalidate');
  }
});

app.get('/health', (c) => c.json({ ok: true, runtime: 'node', app: 'movix-hono' }));

const toCloudflareCtx = (c) => ({
  request: new Request(c.req.url, { method: c.req.method, headers: c.req.raw.headers }),
  env: process.env,
  next: async () => {
    const html = await readFile(INDEX_HTML, 'utf8');
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
});

const socialPreviewHandler = async (c) => {
  const res = await buildSocialPreviewResponse(toCloudflareCtx(c));
  return res;
};

app.get('/movie/:id', socialPreviewHandler);
app.get('/tv/:id', socialPreviewHandler);

app.use('/*', serveStatic({ root: './dist' }));

app.get('*', async (c) => {
  const path = new URL(c.req.url).pathname;
  if (/\.[^/]+$/.test(path)) {
    return c.text('Not Found', 404);
  }
  const html = await readFile(INDEX_HTML, 'utf8');
  return c.html(html);
});

const port = Number(process.env.PORT) || 3001;
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`[server] Movix Hono → http://0.0.0.0:${info.port}`);
});

registerGracefulShutdown(server);
