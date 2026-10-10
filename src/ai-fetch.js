// Сетевой слой для запросов к ИИ-API (DeepSeek — src/deepseek.js, OpenAI —
// src/openai.js) через HTTP-прокси AI_PROXY: свой undici dispatcher у каждого
// клиента SDK, таймаут установки соединения, распознавание ошибок фазы
// соединения. Глобальные настройки сети и HTTP(S)_PROXY не трогаются — S3 и
// веб-пуши ходят как раньше. undici импортируется лениво.

// Таймаут установки соединения на каждом пути: TCP (+ DNS) и TLS, а через
// прокси ещё и ответ прокси на CONNECT.
export const CONNECT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Ошибки фазы установки соединения.
//
// SDK openai превращает любую сетевую ошибку, в тексте которой есть "timeout"
// (в т.ч. ConnectTimeoutError undici), в APIConnectionTimeoutError без cause —
// и таймаут соединения становится неотличим от таймаута ответа. Поэтому наш
// fetch сам распознаёт ошибки фазы соединения и отдаёт SDK ConnectPhaseError
// (без cause и без слова "timeout" в тексте) — SDK кладёт её в
// APIConnectionError.cause как есть.
const CONNECT_PHASE = Symbol("ai connect phase");

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
    super("connect phase failed");
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

// fetch для SDK openai (клиенты DeepSeek и OpenAI) через свой dispatcher:
// через прокси proxyUrl или напрямую (proxyUrl = null). У каждого вызова —
// свой dispatcher, глобальный dispatcher undici не трогается.
// Таймаут соединения — CONNECT_TIMEOUT_MS на каждый этап: TCP до прокси
// (proxyTls), ответ прокси на CONNECT (headersTimeout клиента к прокси), TLS
// до API внутри туннеля (requestTls); напрямую — TCP + TLS одним таймаутом
// коннектора.
export async function createAiFetch(proxyUrl) {
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
export function errorName(err) {
  const ctor = err?.constructor?.name;
  return ctor && ctor !== "Error" && ctor !== "Object" ? ctor : err?.name ?? "error";
}

// Что писать в status= для неудачной попытки: HTTP-код ответа DeepSeek, код
// ошибки соединения или имя ошибки (никогда не message — там бывает URL).
export function attemptStatus(err) {
  return err?.status ?? err?.cause?.code ?? err?.code ?? errorName(err);
}
