import "dotenv/config";

// Ступень B умного поиска (/search-smart): реранк кандидатов ступени A через
// DeepSeek (OpenAI-совместимый API). Пакет "openai" импортируется лениво внутри
// функции — модуль безопасно грузится и без DEEPSEEK_API_KEY.
export const RERANK_MODEL = "deepseek-chat";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const RERANK_TIMEOUT_MS = 10_000;

// ВНИМАНИЕ: system-промпт должен быть полностью статичным (никакой
// интерполяции) — DeepSeek автоматически кэширует одинаковый префикс запроса
// (context caching), это резко снижает стоимость повторных вызовов.
const RERANK_SYSTEM_PROMPT = `Ты помогаешь подобрать позицию из строительного справочника ГЭСН по разговорному описанию работы от прораба.
Тебе дан запрос прораба и список кандидатов (id, название, вариант, путь в каталоге, код ГЭСН).
Оцени релевантность каждого кандидата запросу по шкале от 0 до 1, где 1 — позиция точно описывает запрошенную работу, 0 — не имеет к ней отношения.
Учитывай, что прораб может использовать бытовые формулировки, не совпадающие дословно с официальными терминами ГЭСН.
Верни только JSON вида {"results":[{"id":number,"relevance":number}]}, отсортированный по убыванию релевантности, с оценкой для каждого кандидата из списка.`;

let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    clientPromise = import("openai").then(
      ({ default: OpenAI }) =>
        new OpenAI({
          apiKey: process.env.DEEPSEEK_API_KEY,
          baseURL: DEEPSEEK_BASE_URL,
          timeout: RERANK_TIMEOUT_MS,
          maxRetries: 0,
        })
    );
  }
  return clientPromise;
}

// candidates — [{id, name, variant_label, breadcrumb, gesn_code, similarity}].
// Возвращает Map<id, relevance> или null при любой ошибке (нет ключа, таймаут,
// ошибка API, невалидный JSON) — наружу не бросает.
export async function rerankCandidates(query, candidates) {
  try {
    if (!process.env.DEEPSEEK_API_KEY) {
      console.error("[deepseek rerank] DEEPSEEK_API_KEY не задан — реранк пропущен");
      return null;
    }
    const client = await getClient();

    // similarity намеренно не передаём — чтобы не подсказывать модели.
    const payload = candidates.map((c) => ({
      id: c.id,
      name: c.name,
      variant_label: c.variant_label,
      breadcrumb: c.breadcrumb,
      gesn_code: c.gesn_code,
    }));

    const response = await client.chat.completions.create(
      {
        model: RERANK_MODEL,
        response_format: { type: "json_object" },
        temperature: 0,
        messages: [
          { role: "system", content: RERANK_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Запрос прораба: ${query}\n\nКандидаты:\n${JSON.stringify(payload)}`,
          },
        ],
      },
      { signal: AbortSignal.timeout(RERANK_TIMEOUT_MS) }
    );

    const usage = response.usage;
    if (usage) {
      console.log(
        `[deepseek rerank] usage: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}` +
          ` cache_hit=${usage.prompt_cache_hit_tokens ?? "n/a"} cache_miss=${usage.prompt_cache_miss_tokens ?? "n/a"}`
      );
    }

    const content = response.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed?.results)) {
      console.error("[deepseek rerank] в ответе нет массива results:", content);
      return null;
    }

    const allowedIds = new Set(candidates.map((c) => Number(c.id)));
    const relevance = new Map();
    for (const r of parsed.results) {
      const id = Number(r?.id);
      const score = Number(r?.relevance);
      if (allowedIds.has(id) && Number.isFinite(score)) relevance.set(id, score);
    }
    if (relevance.size === 0) {
      console.error("[deepseek rerank] ни одной валидной оценки в ответе:", content);
      return null;
    }
    return relevance;
  } catch (err) {
    console.error("[deepseek rerank] ошибка:", err?.name, err?.message);
    return null;
  }
}
