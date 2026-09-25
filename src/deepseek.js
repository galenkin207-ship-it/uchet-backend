import "dotenv/config";

// Ступень B умного поиска (/search-smart): реранк кандидатов ступени A через
// DeepSeek (OpenAI-совместимый API). Пакет "openai" импортируется лениво внутри
// функции — модуль безопасно грузится и без DEEPSEEK_API_KEY.
export const RERANK_MODEL = "deepseek-chat";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const RERANK_TIMEOUT_MS = 10_000;
const RAW_LOG_CHARS = 500;

// ВНИМАНИЕ: system-промпт должен быть полностью статичным (никакой
// интерполяции) — DeepSeek автоматически кэширует одинаковый префикс запроса
// (context caching), это резко снижает стоимость повторных вызовов.
const RERANK_SYSTEM_PROMPT = `Ты помогаешь подобрать позицию из строительного справочника ГЭСН по разговорному описанию работы от прораба.
Тебе дан запрос прораба и список кандидатов (id, название, вариант, путь в каталоге, код ГЭСН).
Для каждого кандидата определи уровень уверенности confidence — насколько позиция по смыслу соответствует запрошенной работе:
- "exact" — та же самая работа: совпадают конкретное действие, конструкция, материал и единица измерения (формулировки могут отличаться).
- "likely" — вероятно подходит, но есть неопределённость: в запросе не указан материал, размер, тип конструкции или другой параметр, от которого зависит точный выбор позиции.
- "similar" — похожая тематика, но другая работа (другое действие, конструкция или материал); годится только для справки.
Оценивай смысловое соответствие — единицу измерения, материал, конкретную конструкцию и действие, — а НЕ текстовое сходство и не общую тематику. Похожие слова сами по себе не основание для "exact". Но если действие, конструкция, материал и параметры совпадают — ставь "exact", не занижай оценку из осторожности.
Действие — главный признак работы. Противоположные действия над той же конструкцией (монтаж / демонтаж, установка / снятие, устройство / разборка, прокладка / демонтаж) — это разные работы с разными нормами: такой кандидат — "similar", даже если все остальные слова и параметры совпадают дословно.
Примеры логики:
- Запрос «Демонтаж ящика с рубильником (до 100 А) (с подключением жил приходящих и уходящих кабельных линий)», кандидат «Монтаж ящика с рубильником (до 100 А) (с подключением жил приходящих и уходящих кабельных линий)» — "similar": совпадают все параметры, но действие противоположное.
- Тот же запрос и кандидат «Демонтаж ящика с рубильником (до 100 А) (с подключением жил приходящих и уходящих кабельных линий)» — "exact": совпадают действие, конструкция и параметры.
- Запрос и кандидат относятся к одной общей теме (например, оба про крепёж), но размер и материал в запросе не подтверждают именно эту позицию — это "likely", а не "exact".
Прораб может использовать бытовые формулировки, не совпадающие дословно с официальными терминами ГЭСН, — учитывай это.
Верни только JSON вида {"results":[{"id":number,"confidence":"exact"|"likely"|"similar"}]} с оценкой для каждого кандидата из списка.`;

// Уровни уверенности от лучшего к худшему — порядок сортировки при реранке.
export const CONFIDENCE_LEVELS = ["exact", "likely", "similar"];

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
// Возвращает Map<id, confidence> ("exact" | "likely" | "similar") для каждого
// кандидата (без оценки от модели — "similar") или null при любой ошибке (нет ключа, таймаут,
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
    // Диагностика: сырой ответ модели до парсинга (обрезан, чтобы не засорять лог).
    console.log(`[deepseek rerank] raw response: ${String(content).slice(0, RAW_LOG_CHARS)}`);
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed?.results)) {
      console.error("[deepseek rerank] в ответе нет массива results:", content);
      return null;
    }

    const allowedIds = new Set(candidates.map((c) => Number(c.id)));
    const rated = new Map();
    for (const r of parsed.results) {
      const id = Number(r?.id);
      // Нормализуем регистр/пробелы: "Exact " не должно молча превращаться в "similar".
      const level = String(r?.confidence ?? "").trim().toLowerCase();
      if (allowedIds.has(id) && CONFIDENCE_LEVELS.includes(level)) {
        rated.set(id, level);
      }
    }
    if (rated.size === 0) {
      console.error("[deepseek rerank] ни одной валидной оценки в ответе:", content);
      return null;
    }
    if (rated.size < allowedIds.size) {
      console.log(
        `[deepseek rerank] без валидной оценки ${allowedIds.size - rated.size} из ${allowedIds.size} кандидатов — ставим "similar"`
      );
    }
    const confidence = new Map();
    for (const id of allowedIds) confidence.set(id, rated.get(id) ?? "similar");
    return confidence;
  } catch (err) {
    console.error("[deepseek rerank] ошибка:", err?.name, err?.message);
    return null;
  }
}
