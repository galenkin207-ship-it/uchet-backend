import "dotenv/config";

// Ступень B умного поиска (/search-smart): реранк кандидатов ступени A через
// DeepSeek (OpenAI-совместимый API). Пакеты "openai" и "undici" импортируются
// лениво внутри функций — модуль безопасно грузится и без DEEPSEEK_API_KEY.
//
// Сеть: маршрут из Москвы до api.deepseek.com то открыт, то закрыт, поэтому при
// заданном AI_PROXY (HTTP-прокси, например http://user:pass@host:8888) запросы
// идут через прокси, а при ошибке СОЕДИНЕНИЯ с ним — один раз напрямую, и
// следующие PROXY_DOWN_MS все запросы идут сразу напрямую. Прокси — только у
// клиентов DeepSeek (свой undici dispatcher), глобальные настройки сети и
// HTTP(S)_PROXY не трогаются: OpenAI-эмбеддинги, S3 и веб-пуши ходят как раньше.
export const RERANK_MODEL = "deepseek-chat";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const RERANK_TIMEOUT_MS = 10_000;
// Таймаут установки соединения на каждом пути: TCP (+ DNS) и TLS, а через
// прокси ещё и ответ прокси на CONNECT.
export const CONNECT_TIMEOUT_MS = 5_000;
// Сколько после сбоя прокси ходим сразу напрямую.
export const PROXY_DOWN_MS = 60_000;
const RAW_LOG_CHARS = 500;
const LOG_PREFIX = "[deepseek rerank]";

// ВНИМАНИЕ: system-промпт должен быть полностью статичным (никакой
// интерполяции) — DeepSeek автоматически кэширует одинаковый префикс запроса
// (context caching), это резко снижает стоимость повторных вызовов.
const RERANK_SYSTEM_PROMPT = `Ты помогаешь подобрать позицию из строительного справочника ГЭСН по разговорному описанию работы от прораба.
Тебе дан запрос прораба и список кандидатов (id, название, вариант, путь в каталоге, код ГЭСН, признак keyword_match).
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
keyword_match: true означает, что название кандидата содержит ключевое специфическое слово из запроса или его синоним (не общее слово вроде «монтаж» или «установка», а конкретный термин — материал, изделие, конструкцию). Такие кандидаты заслуживают приоритетного внимания: часть из них добавлена в список именно по этому совпадению, даже если по общему сходству они не были в топе. Если такой кандидат по смыслу подходит (действие, конструкция, материал), это сильный сигнал в пользу "exact" или "likely". Само по себе совпадение слова не делает кандидата подходящим — при другом действии или другой конструкции он остаётся "similar".
Прораб может использовать бытовые формулировки, не совпадающие дословно с официальными терминами ГЭСН, — учитывай это.
Верни только JSON вида {"results":[{"id":number,"confidence":"exact"|"likely"|"similar"}]} с оценкой для каждого кандидата из списка.`;

// Уровни уверенности от лучшего к худшему — порядок сортировки при реранке.
export const CONFIDENCE_LEVELS = ["exact", "likely", "similar"];

// ---------------------------------------------------------------------------
// Ошибки фазы установки соединения.
//
// SDK openai превращает любую сетевую ошибку, в тексте которой есть "timeout"
// (в т.ч. ConnectTimeoutError undici), в APIConnectionTimeoutError без cause —
// и таймаут соединения становится неотличим от таймаута ответа. Поэтому наш
// fetch сам распознаёт ошибки фазы соединения и отдаёт SDK ConnectPhaseError
// (без cause и без слова "timeout" в тексте) — SDK кладёт её в
// APIConnectionError.cause как есть.
const CONNECT_PHASE = Symbol("deepseek connect phase");

// Коды, которые бывают только при установке соединения — страховка на случай,
// если метка CONNECT_PHASE не дошла до ошибки fetch.
const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export class ConnectPhaseError extends Error {
  constructor(code) {
    super("deepseek connect phase failed");
    this.name = "ConnectPhaseError";
    this.code = code;
  }
}

function errorChain(err) {
  const chain = [];
  for (let e = err; e && typeof e === "object" && chain.length < 6; e = e.cause) chain.push(e);
  return chain;
}

// Код ошибки установки соединения или null, если ошибка не из этой фазы
// (ответ сервера, обрыв/таймаут уже после отправки запроса, отмена).
function connectPhaseCode(err) {
  const chain = errorChain(err);
  if (!chain.some((e) => e[CONNECT_PHASE] || CONNECT_ERROR_CODES.has(e.code))) return null;
  const tagged = chain.find((e) => e[CONNECT_PHASE]) ?? chain.find((e) => e.code);
  // undici отдаёт отказ прокси на CONNECT (ответ не 200, в т.ч. 407) как
  // RequestAbortedError (UND_ERR_ABORTED) — даём ему понятное имя.
  if (tagged?.code === "UND_ERR_ABORTED") return "PROXY_CONNECT_REJECTED";
  return tagged?.code ?? tagged?.name ?? "CONNECT_ERROR";
}

// Оборачивает connector undici: ошибка, пришедшая из него, — ошибка фазы
// соединения (TCP/DNS, CONNECT через прокси, TLS).
//
// UND_ERR_SOCKET (прокси/DPI закрыл соединение в ответ на CONNECT) undici
// считает «восстановимой» и без паузы переподключается, пока запрос не отменят
// по общему таймауту — проверено: ~10 000 подключений к прокси за 10 с, без
// fallback. Подменяем её ошибкой с другим кодом, чтобы запрос сразу упал.
function tagConnectErrors(connect) {
  return (opts, callback) =>
    connect(opts, (err, socket) => {
      if (err && typeof err === "object") {
        if (err.code === "UND_ERR_SOCKET") {
          err = new Error("connection closed during connect");
          err.code = "CONNECT_CLOSED";
        }
        err[CONNECT_PHASE] = true;
      }
      callback(err, socket);
    });
}

// fetch для SDK openai через свой dispatcher: через прокси proxyUrl или
// напрямую (proxyUrl = null). Таймаут соединения — CONNECT_TIMEOUT_MS на каждый
// этап: TCP до прокси (proxyTls), ответ прокси на CONNECT (headersTimeout
// клиента к прокси), TLS до DeepSeek внутри туннеля (requestTls); напрямую —
// TCP + TLS одним таймаутом коннектора.
export async function createDeepseekFetch(proxyUrl) {
  const { fetch, Agent, Pool, ProxyAgent, buildConnector } = await import("undici");
  const dispatcher = proxyUrl
    ? new ProxyAgent({
        uri: proxyUrl,
        proxyTls: { timeout: CONNECT_TIMEOUT_MS },
        requestTls: { timeout: CONNECT_TIMEOUT_MS },
        clientFactory: (origin, opts) => new Pool(origin, { ...opts, headersTimeout: CONNECT_TIMEOUT_MS }),
        factory: (origin, opts) => new Pool(origin, { ...opts, connect: tagConnectErrors(opts.connect) }),
      })
    : new Agent({ connect: tagConnectErrors(buildConnector({ timeout: CONNECT_TIMEOUT_MS })) });

  return async (url, init) => {
    try {
      return await fetch(url, { ...init, dispatcher });
    } catch (err) {
      const code = connectPhaseCode(err);
      throw code ? new ConnectPhaseError(code) : err;
    }
  };
}

// Ошибка попытки — сбой соединения (можно пробовать другой путь)?
// Принимает и ошибку SDK (APIConnectionError с cause), и ConnectPhaseError.
export function isConnectError(err) {
  return err instanceof ConnectPhaseError || err?.cause instanceof ConnectPhaseError;
}

// Имя ошибки: у ошибок SDK openai name часто просто "Error" (например, у
// APIUserAbortError — таймаут ответа), имя класса информативнее.
function errorName(err) {
  const ctor = err?.constructor?.name;
  return ctor && ctor !== "Error" && ctor !== "Object" ? ctor : err?.name ?? "error";
}

// Что писать в status= для неудачной попытки: HTTP-код ответа DeepSeek, код
// ошибки соединения или имя ошибки (никогда не message — там бывает URL).
function attemptStatus(err) {
  return err?.status ?? err?.cause?.code ?? err?.code ?? errorName(err);
}

// ---------------------------------------------------------------------------
// Выбор пути: прокси или напрямую.
//
// proxy / direct — функции-попытки: () => Promise<{ status, data }>
// (proxy = null, если AI_PROXY не задан). now — «часы» (подменяются в
// самопроверке scripts/test-deepseek-path.js). Состояние «прокси лежит»
// (proxyDownUntil) живёт в замыкании — в модуле один экземпляр на процесс.
//
// Правила: пока прокси не помечен лежащим — идём через него; при ошибке
// СОЕДИНЕНИЯ — помечаем на PROXY_DOWN_MS и один раз пробуем напрямую. Любые
// другие ошибки (HTTP 4xx/5xx от DeepSeek, таймаут ответа) пробрасываются без
// повтора. Ошибка прямого пути пробрасывается как есть.
export function createPathRunner({ now = Date.now, log = console.log } = {}) {
  let proxyDownUntil = 0;

  async function attempt(via, fn) {
    const started = now();
    try {
      const result = await fn();
      log(`${LOG_PREFIX} via=${via} status=${result.status} ms=${now() - started}`);
      return result;
    } catch (err) {
      log(`${LOG_PREFIX} via=${via} status=${attemptStatus(err)} ms=${now() - started}`);
      throw err;
    }
  }

  return async function run({ proxy, direct }) {
    if (proxy && now() >= proxyDownUntil) {
      try {
        return await attempt("proxy", proxy);
      } catch (err) {
        if (!isConnectError(err)) throw err;
        proxyDownUntil = now() + PROXY_DOWN_MS;
        log(
          `${LOG_PREFIX} proxy failed (${attemptStatus(err)}), fallback direct, direct mode ${PROXY_DOWN_MS / 1000}s`
        );
      }
    }
    return attempt("direct", direct);
  };
}

const runOnPath = createPathRunner();

// ---------------------------------------------------------------------------
// Клиенты SDK: direct — всегда, proxy — только при заданном AI_PROXY.
let clientsPromise = null;

function getClients() {
  if (!clientsPromise) {
    clientsPromise = buildClients().catch((err) => {
      clientsPromise = null; // не кэшируем сбой — следующий запрос попробует снова
      throw err;
    });
  }
  return clientsPromise;
}

async function buildClients() {
  const { default: OpenAI } = await import("openai");
  const makeClient = async (proxyUrl) =>
    new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: DEEPSEEK_BASE_URL,
      timeout: RERANK_TIMEOUT_MS,
      maxRetries: 0,
      fetch: await createDeepseekFetch(proxyUrl),
    });

  const direct = await makeClient(null);
  let proxy = null;
  const proxyUrl = process.env.AI_PROXY?.trim();
  if (proxyUrl) {
    try {
      const { hostname, port, protocol } = new URL(proxyUrl);
      proxy = await makeClient(proxyUrl);
      // Только хост и порт — логин/пароль из URL в журнал не пишем.
      console.log(`${LOG_PREFIX} AI_PROXY задан: ${hostname}:${port || (protocol === "https:" ? "443" : "80")}`);
    } catch (err) {
      console.error(`${LOG_PREFIX} AI_PROXY некорректен (${err?.name}) — работаем только напрямую`);
    }
  }
  return { proxy, direct };
}

// Одна попытка запроса к DeepSeek через данный клиент.
function chatAttempt(client, body) {
  return async () => {
    const { data, response } = await client.chat.completions
      .create(body, { signal: AbortSignal.timeout(RERANK_TIMEOUT_MS) })
      .withResponse();
    return { status: response.status, data };
  };
}

// candidates — [{id, name, variant_label, breadcrumb, gesn_code, similarity, keywordMatch}].
// Возвращает { ok: true, confidence } — confidence: Map<id, "exact" | "likely" | "similar">
// для каждого кандидата (без оценки от модели — "similar"), или { ok: false }
// при любой ошибке (нет ключа, сеть, таймаут, ошибка API, невалидный JSON) —
// наружу не бросает.
export async function rerankCandidates(query, candidates) {
  const failed = { ok: false };
  try {
    if (!process.env.DEEPSEEK_API_KEY) {
      console.error(`${LOG_PREFIX} DEEPSEEK_API_KEY не задан — реранк пропущен`);
      return failed;
    }
    const clients = await getClients();

    // similarity намеренно не передаём — чтобы не подсказывать модели.
    const payload = candidates.map((c) => ({
      id: c.id,
      name: c.name,
      variant_label: c.variant_label,
      breadcrumb: c.breadcrumb,
      gesn_code: c.gesn_code,
      keyword_match: Boolean(c.keywordMatch),
    }));

    const body = {
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
    };
    const { data: response } = await runOnPath({
      proxy: clients.proxy && chatAttempt(clients.proxy, body),
      direct: chatAttempt(clients.direct, body),
    });

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
      return failed;
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
      return failed;
    }
    if (rated.size < allowedIds.size) {
      console.log(
        `[deepseek rerank] без валидной оценки ${allowedIds.size - rated.size} из ${allowedIds.size} кандидатов — ставим "similar"`
      );
    }
    const confidence = new Map();
    for (const id of allowedIds) confidence.set(id, rated.get(id) ?? "similar");
    return { ok: true, confidence };
  } catch (err) {
    // Только имя и код: message ошибок сети/SDK может содержать URL.
    console.error(`${LOG_PREFIX} ошибка: ${errorName(err)} ${err?.cause?.code ?? err?.status ?? ""}`.trimEnd());
    return failed;
  }
}
