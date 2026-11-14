import "dotenv/config";

// Локальные эмбеддинги (bge-m3) через службу uchet-embed на 127.0.0.1.
const EMBED_URL = process.env.EMBED_URL || "http://127.0.0.1:3100/embed";
const LOG_PREFIX = "[embed]";
const QUERY_TIMEOUT_MS = 10_000; // поиск: пользователь ждёт ответа
const DOC_TIMEOUT_MS = 30_000; // фоновый пересчёт позиций

async function embedTexts(texts, timeoutMs) {
  const started = Date.now();
  let status = "-";
  try {
    const res = await fetch(EMBED_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    if (!res.ok) {
      const err = new Error("embed service error");
      err.status = res.status;
      throw err;
    }
    const { vectors } = await res.json();
    if (
      !Array.isArray(vectors) ||
      vectors.length !== texts.length ||
      vectors.some((v) => !Array.isArray(v) || v.length !== 1024)
    ) {
      throw new Error("embed service bad response");
    }
    return vectors;
  } catch (err) {
    if (status === "-") status = err?.cause?.code ?? err?.name ?? "error";
    throw err;
  } finally {
    // только статус и время, без текста запроса
    console.log(`${LOG_PREFIX} status=${status} n=${texts.length} ms=${Date.now() - started}`);
  }
}

export async function getEmbedding(text) {
  return (await embedTexts([text], DOC_TIMEOUT_MS))[0];
}

export async function getQueryEmbedding(text) {
  return (await embedTexts([text], QUERY_TIMEOUT_MS))[0];
}
export async function getEmbeddings(texts) {
  return embedTexts(texts, DOC_TIMEOUT_MS);
}