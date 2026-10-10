// Самопроверка выбора пути DeepSeek (прокси / напрямую) без сети:
//   node scripts/test-deepseek-path.js
// Попытки — фейковые функции, время — подменённые «часы».
import assert from "node:assert/strict";
import { createPathRunner, PROXY_DOWN_MS } from "../src/deepseek.js";
import { ConnectPhaseError } from "../src/ai-fetch.js";

// Ошибки в том виде, в каком их отдаёт SDK openai.
const connectError = (code) => Object.assign(new Error("Connection error."), { cause: new ConnectPhaseError(code) });
const httpError = (status) => Object.assign(new Error(`${status} status code`), { status });
const readTimeout = () => Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });

function setup() {
  const clock = { t: 1_000_000 };
  const logs = [];
  const calls = [];
  const run = createPathRunner({ now: () => clock.t, log: (line) => logs.push(line) });
  const attempt = (via, outcome) => async () => {
    calls.push(via);
    if (outcome instanceof Error) throw outcome;
    return { status: 200, data: outcome };
  };
  return { clock, logs, calls, run, attempt };
}

const cases = {
  "(а) прокси ECONNREFUSED → одна попытка напрямую, дальше в пределах 60 с сразу напрямую": async () => {
    const { clock, logs, calls, run, attempt } = setup();
    const r1 = await run({ proxy: attempt("proxy", connectError("ECONNREFUSED")), direct: attempt("direct", "d1") });
    assert.equal(r1.data, "d1");
    assert.deepEqual(calls, ["proxy", "direct"]);
    assert.ok(logs.some((l) => l.includes("proxy failed (ECONNREFUSED), fallback direct, direct mode 60s")));
    assert.ok(logs.some((l) => /via=proxy status=ECONNREFUSED ms=\d+/.test(l)));
    assert.ok(logs.some((l) => /via=direct status=200 ms=\d+/.test(l)));

    clock.t += PROXY_DOWN_MS - 1;
    const r2 = await run({ proxy: attempt("proxy", "p2"), direct: attempt("direct", "d2") });
    assert.equal(r2.data, "d2");
    assert.deepEqual(calls, ["proxy", "direct", "direct"]);
  },

  "(а') прямой путь после сбоя прокси пробуется один раз, ошибка пробрасывается": async () => {
    const { calls, run, attempt } = setup();
    await assert.rejects(
      run({ proxy: attempt("proxy", connectError("UND_ERR_CONNECT_TIMEOUT")), direct: attempt("direct", connectError("ENOTFOUND")) }),
      (err) => err.cause?.code === "ENOTFOUND"
    );
    assert.deepEqual(calls, ["proxy", "direct"]);
  },

  "(б) после 60 с снова пробуем прокси": async () => {
    const { clock, calls, run, attempt } = setup();
    await run({ proxy: attempt("proxy", connectError("ECONNREFUSED")), direct: attempt("direct", "d1") });
    clock.t += PROXY_DOWN_MS;
    const r = await run({ proxy: attempt("proxy", "p2"), direct: attempt("direct", "d2") });
    assert.equal(r.data, "p2");
    assert.deepEqual(calls, ["proxy", "direct", "proxy"]);
  },

  "(в) ответ DeepSeek 401 через прокси → прямой путь не пробуем, прокси не помечаем": async () => {
    const { calls, logs, run, attempt } = setup();
    await assert.rejects(
      run({ proxy: attempt("proxy", httpError(401)), direct: attempt("direct", "d1") }),
      (err) => err.status === 401
    );
    assert.deepEqual(calls, ["proxy"]);
    assert.ok(logs.some((l) => /via=proxy status=401 ms=\d+/.test(l)));
    assert.ok(!logs.some((l) => l.includes("fallback")));
    // прокси не помечен лежащим — следующий вызов снова через прокси
    await run({ proxy: attempt("proxy", "p2"), direct: attempt("direct", "d2") });
    assert.deepEqual(calls, ["proxy", "proxy"]);
  },

  "(г) таймаут ответа через прокси → не повторяем": async () => {
    const { calls, logs, run, attempt } = setup();
    await assert.rejects(run({ proxy: attempt("proxy", readTimeout()), direct: attempt("direct", "d1") }));
    assert.deepEqual(calls, ["proxy"]);
    assert.ok(logs.some((l) => /via=proxy status=APIUserAbortError ms=\d+/.test(l)));
  },

  "(д) AI_PROXY не задан → только прямой путь": async () => {
    const { calls, run, attempt } = setup();
    const r = await run({ proxy: null, direct: attempt("direct", "d1") });
    assert.equal(r.data, "d1");
    await assert.rejects(run({ proxy: null, direct: attempt("direct", connectError("ECONNREFUSED")) }));
    assert.deepEqual(calls, ["direct", "direct"]);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  try {
    await fn();
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n  ${err?.message}`);
  }
}
if (failed) {
  console.error(`${failed} из ${Object.keys(cases).length} кейсов не прошли`);
  process.exit(1);
}
console.log(`OK: ${Object.keys(cases).length} кейсов`);
