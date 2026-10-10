// Самопроверка клиента OpenAI (эмбеддинги) с AI_PROXY без выхода в сеть:
//   node scripts/test-openai-proxy.js
// «Прокси» — закрытый порт на 127.0.0.1, время — подменённые «часы».
import assert from "node:assert/strict";
import net from "node:net";

// Ключ-заглушка до импорта: SDK требует apiKey при создании клиента.
process.env.OPENAI_API_KEY ||= "sk-test";
const { buildClient, loggedCall } = await import("../src/openai.js");
const { isConnectError } = await import("../src/ai-fetch.js");

const fakeClock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
};

async function closedPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

const cases = {
  "AI_PROXY не задан → клиент как раньше (глобальный fetch), via=direct": async () => {
    const { client, via } = await buildClient("");
    assert.equal(via, "direct");
    assert.equal(client.fetch, globalThis.fetch);
  },

  "AI_PROXY задан → свой fetch через прокси, via=proxy": async () => {
    const { client, via } = await buildClient("http://user:secret@127.0.0.1:8888");
    assert.equal(via, "proxy");
    assert.notEqual(client.fetch, globalThis.fetch);
  },

  "некорректный AI_PROXY → ошибка без URL и пароля": async () => {
    await assert.rejects(buildClient("http://user:secret@[bad"), (err) => {
      assert.ok(!String(err.message).includes("secret"));
      assert.ok(!JSON.stringify(err).includes("secret"));
      return true;
    });
  },

  "успешный запрос → строка журнала via/status/ms": async () => {
    const clock = fakeClock();
    const logs = [];
    const data = await loggedCall(
      "proxy",
      async () => {
        clock.advance(42);
        return { data: "ok", response: { status: 200 } };
      },
      { now: clock.now, log: (l) => logs.push(l) }
    );
    assert.equal(data, "ok");
    assert.deepEqual(logs, ["[openai embed] via=proxy status=200 ms=42"]);
  },

  "403 от OpenAI → status=403, ошибка пробрасывается, текст ошибки не пишется": async () => {
    const logs = [];
    const err403 = Object.assign(new Error("403 unsupported_country_region_territory"), { status: 403 });
    await assert.rejects(
      loggedCall("proxy", async () => { throw err403; }, { log: (l) => logs.push(l) }),
      (err) => err === err403
    );
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[openai embed\] via=proxy status=403 ms=\d+$/);
  },

  "прокси недоступен (ECONNREFUSED) → ошибка эмбеддинга, прямого пути нет": async () => {
    const port = await closedPort();
    const { client, via } = await buildClient(`http://127.0.0.1:${port}`);
    const directCalls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (...args) => {
      directCalls.push(args[0]);
      return realFetch(...args);
    };
    const logs = [];
    try {
      await assert.rejects(
        loggedCall(via, () => client.withOptions({ maxRetries: 0 }).embeddings.create({ model: "m", input: "x" }).withResponse(), {
          log: (l) => logs.push(l),
        }),
        (err) => isConnectError(err)
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(directCalls, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[openai embed\] via=proxy status=ECONNREFUSED ms=\d+$/);
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
