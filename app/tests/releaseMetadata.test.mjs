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

test("release metadata targets the mandatory 2.5.5 build 14 update", () => {
  assert.equal(release.version, "2.5.5");
  assert.equal(release.buildNumber, 14);
  assert.equal(release.mandatory, true);
  assert.equal(
    release.apkUrl,
    "https://raw.githubusercontent.com/movixcorp/MovixOpenSource/main/app/movix-android.apk",
  );

  assert.equal(appConfig.version, "2.5.5");
  assert.equal(appConfig.buildNumber, "14");
  assert.match(gradle, /\bversionCode\s+14\b/);
  assert.match(gradle, /\bversionName\s+"2\.5\.5"/);
});

test("release notes only describe the Bravo and Fsvid/Vidzy fixes", () => {
  assert.equal(
    release.releaseNotes.fr,
    "Correction du proxy Bravo sur Android pour les sous-titres VTT/SRT.\n" +
      "Correction de l'extraction Fsvid et Vidzy pour le nouveau format Base64/XOR.",
  );
  assert.equal(
    release.releaseNotes.en,
    "Fixed the Bravo proxy on Android for VTT/SRT subtitles.\n" +
      "Fixed Fsvid and Vidzy extraction for the new Base64/XOR format.",
  );

  const notes = normalized(release.releaseNotes.fr);
  for (const removed of ["nexus", "uqload", "mise a jour automatique", "ecran"]) {
    assert.ok(!notes.includes(removed), `releaseNotes.fr ne doit plus contenir "${removed}"`);
  }
});

test("APK integrity metadata remains publishable", () => {
  assert.ok(Number.isSafeInteger(release.apkSizeBytes));
  assert.ok(release.apkSizeBytes > 0);
  assert.match(release.apkSha256, /^[a-f0-9]{64}$/);
  assert.match(release.releasedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
