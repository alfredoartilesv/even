import test from "node:test";
import assert from "node:assert/strict";
import { assertPerfPackage, badgingPackage } from "../scripts/lib/perfPackage.mjs";

test("timing builds install only under a .perf package, never over the real app", () => {
  for (const ok of ["app.health.personal.perf", "app.health.personal.perf2"]) assert.equal(assertPerfPackage(ok), ok);
  for (const bad of ["app.health.personal", "app.health.personal.debug", "app.health.personal.perfx", "", undefined]) {
    assert.throws(() => assertPerfPackage(bad as string), /not a timing build/, String(bad));
  }
  assert.equal(badgingPackage("package: name='app.health.personal.perf' versionCode='102' versionName='0.1.2'"), "app.health.personal.perf");
  assert.equal(badgingPackage("no package line"), null);
});
