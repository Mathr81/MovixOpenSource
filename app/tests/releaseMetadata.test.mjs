import assert from "node:assert/strict";
import crypto from "node:crypto";
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

test("release metadata keeps the mandatory 2.5.7 build 16 update", () => {
  assert.equal(release.version, "2.5.7");
  assert.equal(release.buildNumber, 16);
  assert.equal(release.mandatory, true);
  assert.equal(
    release.apkUrl,
    "https://raw.githubusercontent.com/movixcorp/MovixOpenSource/main/app/movix-android.apk",
  );

  assert.equal(appConfig.version, "2.5.7");
  assert.equal(appConfig.buildNumber, "16");
  assert.match(gradle, /\bversionCode\s+16\b/);
  assert.match(gradle, /\bversionName\s+"2\.5\.7"/);
});

test("release notes describe Cast, screen wake, recovery and the Picture-in-Picture fix", () => {
  assert.equal(
    release.releaseNotes.fr,
    "Correction du Cast : il devrait désormais fonctionner avec à peu près " +
      "toutes les sources. La lecture locale se rétablit correctement après " +
      "une déconnexion du Cast. L’écran ne s’éteint plus pendant le visionnage " +
      "d’un contenu. Le mode Picture-in-Picture a également été corrigé.",
  );
  assert.equal(
    release.releaseNotes.en,
    "Cast fixes: it should now work with nearly all sources. Local playback " +
      "now recovers correctly after disconnecting from Cast. The screen no " +
      "longer turns off while watching content. Picture-in-Picture mode has " +
      "also been fixed.",
  );

  const notes = normalized(release.releaseNotes.fr);
  assert.ok(notes.includes("a peu pres toutes les sources"));
  assert.ok(notes.includes("deconnexion du cast"));
  assert.ok(notes.includes("ne s’eteint plus"));
  assert.ok(notes.includes("picture-in-picture"));
  assert.ok(notes.includes("egalement ete corrige"));
});

test("APK integrity metadata matches the published artifact", () => {
  const apk = fs.readFileSync(path.join(appDirectory, "movix-android.apk"));
  const actualSha256 = crypto.createHash("sha256").update(apk).digest("hex");

  assert.ok(Number.isSafeInteger(release.apkSizeBytes));
  assert.ok(release.apkSizeBytes > 0);
  assert.equal(release.apkSizeBytes, apk.byteLength);
  assert.match(release.apkSha256, /^[a-f0-9]{64}$/);
  assert.equal(release.apkSha256, actualSha256);
  assert.match(release.releasedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
