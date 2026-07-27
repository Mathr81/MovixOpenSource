import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(testsDirectory, "..");
const release = JSON.parse(
  fs.readFileSync(path.join(appDirectory, "version.json"), "utf8"),
);
const appConfig = JSON.parse(
  fs.readFileSync(path.join(appDirectory, "app.json"), "utf8"),
);
const gradle = fs.readFileSync(
  path.join(appDirectory, "android", "app", "build.gradle"),
  "utf8",
);

const normalized = (value) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

test("release metadata targets the mandatory 2.5.4 build 13 update", () => {
  assert.equal(release.version, "2.5.4");
  assert.equal(release.buildNumber, 13);
  assert.equal(release.mandatory, true);
  assert.equal(
    release.apkUrl,
    "https://raw.githubusercontent.com/movixcorp/MovixOpenSource/main/app/movix-android.apk",
  );

  assert.equal(appConfig.version, "2.5.4");
  assert.equal(appConfig.buildNumber, "13");
  assert.match(gradle, /\bversionCode\s+13\b/);
  assert.match(gradle, /\bversionName\s+"2\.5\.4"/);
});

test("French release notes aggregate the previous and current fixes", () => {
  const notes = normalized(release.releaseNotes.fr);

  for (const expected of [
    "nexus",
    "bravo",
    "uqload",
    "mise a jour automatique",
    "ecran",
    "vidzy",
    "fsvid",
    "proxy",
  ]) {
    assert.ok(notes.includes(expected), `releaseNotes.fr doit contenir "${expected}"`);
  }
});

test("APK integrity metadata remains publishable", () => {
  assert.ok(Number.isSafeInteger(release.apkSizeBytes));
  assert.ok(release.apkSizeBytes > 0);
  assert.match(release.apkSha256, /^[a-f0-9]{64}$/);
  assert.match(release.releasedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
