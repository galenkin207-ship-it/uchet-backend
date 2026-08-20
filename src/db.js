import pg from "pg";
import "dotenv/config";

export const pool = new pg.Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "uchet_db",
  user: process.env.DB_USER || "uchet_app",
  password: process.env.DB_PASSWORD,
  max: 10,
});

pool.on("error", (err) => {
  console.error("Неожиданная ошибка простаивающего клиента Postgres:", err);
});
