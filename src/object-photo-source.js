// Единый источник «фото объекта за дату»: фото записей (record_photos) и
// фото-отчёты по объекту (object_photos) в одном формате строки. Все чтения
// фото-отчётов идут через ACTIVE_OBJECT_PHOTOS — фильтр мягкого удаления
// (deleted_at IS NULL) живёт только здесь.

// Неудалённые фото-отчёты. Подзапрос без агрегатов планировщик разворачивает,
// так что индексы object_photos (в т.ч. частичный WHERE deleted_at IS NULL)
// используются как обычно.
export const ACTIVE_OBJECT_PHOTOS = "(SELECT * FROM object_photos WHERE deleted_at IS NULL)";

// «Сегодня» — текущие сутки по Москве, а не по таймзоне сервера/сессии БД.
// Границы — выражения от now() (stable), поэтому планировщик использует
// индексы по created_at. Сравнение timestamptz-границ корректно и если
// records.created_at — timestamp без зоны (он приводится по TimeZone сессии,
// в которой и был записан через DEFAULT now()).
const MSK_DAY = "date_trunc('day', now() AT TIME ZONE 'Europe/Moscow')";
export const TODAY_START = `(${MSK_DAY} AT TIME ZONE 'Europe/Moscow')`;
export const TODAY_END = `((${MSK_DAY} + interval '1 day') AT TIME ZONE 'Europe/Moscow')`;

// Сегодняшняя дата по Москве в виде YYYY-MM-DD.
export function moscowToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}

// Какие записи участвуют (алиас r): только привязанные к объекту; либо
// только завершённые (doneOnly — как GET /api/objects/:id/photos), либо всё,
// кроме чужих черновиков (как GET /api/records, userParam обязателен).
export function recordFilterSql({ userParam, objectParam, doneOnly = false }) {
  return [
    "r.object_id IS NOT NULL",
    doneOnly ? "r.status = 'done'" : `(r.status <> 'draft' OR r.created_by_user_id = ${userParam})`,
    ...(objectParam ? [`r.object_id = ${objectParam}`] : []),
  ].join(" AND ");
}

// CTE object_photo_source со строками:
//   source ('record'|'report'), source_id (records.id | object_photos.id),
//   object_id, file_path, photo_date (records.date | object_photos.photo_date),
//   uploaded_at (COALESCE(record_photos.created_at, records.created_at) |
//   object_photos.created_at), user_id (автор), comment, sort_order.
// Фильтры подставляются внутрь каждой ветки UNION ALL, чтобы работали индексы:
//   objectParam      — только этот объект;
//   fromParam/toParam — по photo_date (включительно);
//   uploadedToday    — uploaded_at в пределах сегодняшних суток по Москве;
//   sources          — какие ветки включать;
//   userParam/doneOnly — правило видимости записей, см. recordFilterSql.
// Параметры — готовые плейсхолдеры ("$1"...), нумерацию ведёт вызывающий код.
// Контракт единого источника — порядок колонок во всех ветках UNION ALL.
export const OBJECT_PHOTO_SOURCE_COLUMNS = [
  "source", // text: 'record' | 'report'
  "source_id", // int: records.id | object_photos.id
  "object_id", // int
  "file_path", // text, без S3_PREFIX
  "photo_date", // date: records.date | object_photos.photo_date
  "uploaded_at", // timestamptz
  "user_id", // int: автор
  "comment", // text
  "sort_order", // int: порядок фото внутри записи, у фото-отчётов 0
];

export function objectPhotoSourceCte({
  userParam,
  objectParam,
  fromParam,
  toParam,
  uploadedToday = false,
  doneOnly = false,
  sources = ["record", "report"],
}) {
  const branches = [];

  if (sources.includes("record")) {
    const where = [recordFilterSql({ userParam, objectParam, doneOnly })];
    if (fromParam) where.push(`r.date >= ${fromParam}::date`);
    if (toParam) where.push(`r.date <= ${toParam}::date`);
    const select = `SELECT 'record'::text AS source, r.id::int AS source_id, r.object_id::int AS object_id,
               p.file_path::text AS file_path, r.date::date AS photo_date,
               COALESCE(p.created_at::timestamptz, r.created_at::timestamptz) AS uploaded_at,
               r.created_by_user_id::int AS user_id, r.comment::text AS comment, p.sort_order::int AS sort_order
          FROM record_photos p JOIN records r ON r.id = p.record_id`;
    if (uploadedToday) {
      // Две ветки вместо COALESCE в WHERE — так каждая идёт по своему индексу.
      // Фото, загруженные до миграции 032, времени загрузки не имеют — для
      // них берётся время создания записи.
      branches.push(
        `${select} WHERE ${where.join(" AND ")} AND p.created_at >= ${TODAY_START} AND p.created_at < ${TODAY_END}`,
        `${select} WHERE ${where.join(" AND ")} AND p.created_at IS NULL
           AND r.created_at >= ${TODAY_START} AND r.created_at < ${TODAY_END}`,
      );
    } else {
      branches.push(`${select} WHERE ${where.join(" AND ")}`);
    }
  }

  if (sources.includes("report")) {
    const where = ["TRUE"];
    if (objectParam) where.push(`op.object_id = ${objectParam}`);
    if (fromParam) where.push(`op.photo_date >= ${fromParam}::date`);
    if (toParam) where.push(`op.photo_date <= ${toParam}::date`);
    if (uploadedToday) where.push(`op.created_at >= ${TODAY_START} AND op.created_at < ${TODAY_END}`);
    branches.push(`SELECT 'report'::text AS source, op.id::int AS source_id, op.object_id::int AS object_id,
               op.file_path::text AS file_path, op.photo_date::date AS photo_date,
               op.created_at::timestamptz AS uploaded_at,
               op.user_id::int AS user_id, op.comment::text AS comment, 0::int AS sort_order
          FROM ${ACTIVE_OBJECT_PHOTOS} op
         WHERE ${where.join(" AND ")}`);
  }

  // Имена колонок задаются списком у самого CTE, а не первой веткой UNION ALL:
  // при sources:["report"] первой оказывалась ветка фото-отчётов, и CTE
  // отдавал колонки с другими именами (s.source_id does not exist). Типы
  // в ветках приведены явно, чтобы UNION ALL совпадал при любом наборе веток.
  if (!branches.length) throw new Error("objectPhotoSourceCte: no sources");
  return `object_photo_source (${OBJECT_PHOTO_SOURCE_COLUMNS.join(", ")}) AS (
      ${branches.join("\n      UNION ALL\n      ")}
    )`;
}

// Строгая проверка даты вида YYYY-MM-DD (существующий календарный день).
export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
