import pg from "pg";
import "dotenv/config";

if (!process.env.DB_PASSWORD) {
  console.error(
    "ВНИМАНИЕ: DB_PASSWORD не задан в .env. Если аутентификация БД требует пароль " +
      "(обычный случай для uchet_app), все запросы к базе будут падать с ошибкой " +
      "аутентификации сразу после старта. См. .env.example.",
  );
}

export const pool = new pg.Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "uchet_db",
  user: process.env.DB_USER || "uchet_app",
  password: process.env.DB_PASSWORD,
  max: 10,
  // Без этих лимитов один медленный/зависший запрос (например, отчёт с большим
  // диапазоном дат, или клиент, начавший транзакцию и не завершивший её из-за
  // бага) мог держать соединение неограниченно долго — а остальные запросы
  // просто вставали в очередь без таймаута, замедляя всё приложение сразу.
  statement_timeout: 20_000, // максимум на один SQL-запрос
  idle_in_transaction_session_timeout: 30_000, // максимум простоя внутри открытой транзакции
  connectionTimeoutMillis: 5_000, // не ждать свободное соединение из пула дольше этого
  idleTimeoutMillis: 30_000, // закрывать простаивающие соединения через это время
});

pool.on("error", (err) => {
  console.error("Неожиданная ошибка простаивающего клиента Postgres:", err);
});
