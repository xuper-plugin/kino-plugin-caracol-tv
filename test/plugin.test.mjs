// Stand-in del plugin de Caracol TV — creada con `node plugins/sdk/init.mjs`.
// Tests offline: reanuda desde test/fixtures.json (grabar una vez con
//   node plugins/sdk/run.mjs --record test/fixtures.json . search "pasión").
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../sdk/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "test", "fixtures.json");

test("Kino acepta el manifiesto y las exportaciones", async () => {
  const r = await validate(root);
  assert.deepEqual(r.problems, []);
});

test("search responde offline, Kino no tira nada", { skip: skip }, async () => {
  const r = await validate(root, { run: "search", args: ["pasión"], replay: fixtures });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.drops, []);
  assert.ok(r.output.items.length > 0);
});

function skip() {
  return !existsSync(fixtures) && "graba test/fixtures.json primero";
}