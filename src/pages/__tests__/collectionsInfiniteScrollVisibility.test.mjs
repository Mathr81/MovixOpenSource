import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const collectionsPath = new URL('../Collections.tsx', import.meta.url);

test('les collections ajoutées par le scroll infini sont animées explicitement vers l’état visible', async () => {
  const source = await readFile(collectionsPath, 'utf8');
  const dynamicItems = [
    ...source.matchAll(
      /<motion\.div\s+key=\{collection\.id\}([\s\S]*?)>\s*<(CollectionCard|CollectionListItem)/g,
    ),
  ];

  assert.equal(dynamicItems.length, 2, 'les modes grille et liste doivent être couverts');

  for (const [, attributes, component] of dynamicItems) {
    assert.match(
      attributes,
      /initial=\{newCollectionIds\.has\(collection\.id\) \? ['"]hidden['"] : false\}/,
      `${component} doit masquer uniquement les nouvelles collections avant leur animation`,
    );
    assert.match(
      attributes,
      /animate="visible"/,
      `${component} doit toujours recevoir explicitement l’état visible`,
    );
    assert.match(attributes, /variants=\{itemVariants\}/);
  }
});
