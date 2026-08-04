import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const extensionDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const chromeDirectory = path.join(extensionDirectory, 'Chrome');
const firefoxDirectory = path.join(extensionDirectory, 'Firefox');
const javascriptName = 'fsvid-vidzy-quickjs.js';

await Promise.all([mkdir(chromeDirectory, { recursive: true }), mkdir(firefoxDirectory, { recursive: true })]);

await build({
  entryPoints: [path.join(extensionDirectory, 'runtime', 'fsvid-vidzy-quickjs-entry.js')],
  outfile: path.join(chromeDirectory, javascriptName),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome109', 'firefox109'],
  minify: true,
  legalComments: 'none',
  sourcemap: false,
});

await copyFile(
  path.join(chromeDirectory, javascriptName),
  path.join(firefoxDirectory, javascriptName),
);
