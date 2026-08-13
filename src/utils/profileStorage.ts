import {
  isSyncableStorageKey,
  shouldPreserveStorageKeyOnProfileLoad,
} from './syncStorage.ts';

export function replaceProfileStorage(
  entries: Record<string, string>,
  storage: Storage = window.localStorage,
): void {
  const existingKeys: string[] = [];

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key) existingKeys.push(key);
  }

  const removableKeys = existingKeys.filter(
    (key) => isSyncableStorageKey(key) && !shouldPreserveStorageKeyOnProfileLoad(key),
  );
  const writableEntries = Object.entries(entries).filter(
    ([key, value]) => typeof value === 'string' && isSyncableStorageKey(key),
  );
  const affectedKeys = new Set([
    ...removableKeys,
    ...writableEntries.map(([key]) => key),
  ]);
  const snapshot = new Map(
    [...affectedKeys].map((key) => [key, storage.getItem(key)]),
  );

  try {
    for (const key of removableKeys) {
      storage.removeItem(key);
    }

    for (const [key, value] of writableEntries) {
      storage.setItem(key, value);
    }
  } catch (error) {
    for (const key of snapshot.keys()) {
      storage.removeItem(key);
    }

    for (const [key, value] of snapshot) {
      if (value !== null) {
        storage.setItem(key, value);
      }
    }
    throw error;
  }
}
