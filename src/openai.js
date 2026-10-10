import "dotenv/config";
import OpenAI from "openai";
import { createAiFetch, attemptStatus } from "./ai-fetch.js";

export const EMBEDDING_MODEL = "text-embedding-3-small";
const LOG_PREFIX = "[openai embed]";

if (!process.env.OPENAI_API_KEY) {
  console.error(
    "ВНИМАНИЕ: OPENAI_API_KEY не задан в .env. Умный поиск и пересчёт эмбеддингов будут падать с ошибкой."
  );
}

// OpenAI не принимает запросы с российского IP (403
// unsupported_country_region_territory), поэтому при заданном AI_PROXY все
// запросы к OpenAI идут только через прокси (свой undici dispatcher у этого
// клиента, src/ai-fetch.js). Прямого запасного пути нет — из Москвы он заведомо
// закрыт: ошибка прокси = ошибка эмбеддинга. Состояние «прокси лежит» у
// DeepSeek (src/deepseek.js) сюда не относится. Без AI_PROXY — как раньше:
// клиент с настройками SDK по умолчанию и глобальным fetch.
let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    clientPromise = buildClient().catch((err) => {
      clientPromise = null; // не кэшируем сбой — следующий запрос попробует снова
      throw err;
    });
  }
  return clientPromise;
}

// { client, via } — via: "proxy" | "direct" (для журнала).
export async function buildClient(proxyUrl = process.env.AI_PROXY?.trim()) {
  if (!proxyUrl) {
    return { client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), via: "direct" };
  }
  let fetch;
  try {
    fetch = await createAiFetch(proxyUrl);
  } catch (err) {
    // Ошибка разбора AI_PROXY содержит сам URL (с паролем) — наружу и в журнал
    // отдаём только имя.
    console.error(`${LOG_PREFIX} AI_PROXY некорректен (${err?.name}) — запросы к OpenAI невозможны`);
    throw new Error("AI_PROXY некорректен");
  }
  return { client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch }), via: "proxy" };
}

// Одна строка журнала на запрос к OpenAI: via, HTTP-код или код/имя ошибки,
// время. Текст ошибок и ключ не пишем. now/log подменяются в самопроверке
// scripts/test-openai-proxy.js.
export async function loggedCall(via, fn, { now = Date.now, log = console.log } = {}) {
  const started = now();
  try {
    const { data, response } = await fn();
    log(`${LOG_PREFIX} via=${via} status=${response.status} ms=${now() - started}`);
    return data;
  } catch (err) {
    log(`${LOG_PREFIX} via=${via} status=${attemptStatus(err)} ms=${now() - started}`);
    throw err;
  }
}

// input — строка или массив строк (батч). Возвращает ответ embeddings.create.
export async function createEmbeddings(input) {
  const { client, via } = await getClient();
  return loggedCall(via, () =>
    client.embeddings.create({ model: EMBEDDING_MODEL, input }).withResponse()
  );
}

export async function getEmbedding(text) {
  const response = await createEmbeddings(text);
  return response.data[0].embedding;
}
