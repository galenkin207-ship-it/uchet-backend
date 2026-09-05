// Аварийный сброс пароля напрямую в базе — для случая, когда единственный
// админ забыл свой пароль и не может зайти в приложение, чтобы сбросить его
// через страницу "Пользователи" (там нужен уже активный вход админа).
//
// Запускать НА СЕРВЕРЕ через MobaXterm, из папки бэкенда (важно — там же
// лежит .env с DB_* и SESSION_SECRET, которые читает pool/hashPassword):
//   cd /opt/uchet/server              (для прода)
//   cd /opt/uchet-staging/backend-src (для staging)
//   node scripts/reset-password.js <login> <новый_пароль>
//
// Если логин неизвестен — запустите без аргументов, скрипт выведет список
// всех логинов с ролями, чтобы можно было выбрать нужный.
import { pool } from "../src/db.js";
import { hashPassword } from "../src/auth.js";

const MIN_PASSWORD_LENGTH = 6;

async function listUsers() {
  const { rows } = await pool.query(
    `SELECT login, full_name, role, active FROM users ORDER BY role, login`,
  );
  console.log("Логин не указан. Пользователи в этой базе:\n");
  for (const u of rows) {
    console.log(
      `  ${u.login.padEnd(20)} ${u.full_name.padEnd(30)} ${u.role}${u.active ? "" : "  (неактивен)"}`,
    );
  }
  console.log("\nЗапустите: node scripts/reset-password.js <логин> <новый_пароль>");
}

async function main() {
  const [login, newPassword] = process.argv.slice(2);

  if (!login) {
    await listUsers();
    process.exit(0);
  }

  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    console.error(`Нужен пароль длиной от ${MIN_PASSWORD_LENGTH} символов вторым аргументом.`);
    console.error("Пример: node scripts/reset-password.js admin НовыйПароль123");
    process.exit(1);
  }

  const password_hash = await hashPassword(newPassword);
  const { rows } = await pool.query(
    `UPDATE users SET password_hash = $1 WHERE login = $2
     RETURNING id, login, full_name, role, active`,
    [password_hash, login],
  );

  if (!rows[0]) {
    console.error(`Пользователь с логином "${login}" не найден.`);
    await listUsers();
    process.exit(1);
  }

  const u = rows[0];
  console.log(`Готово. Пароль обновлён для: ${u.full_name} (${u.login}, роль ${u.role}).`);
  if (!u.active) {
    console.log(
      `Внимание: этот пользователь помечен неактивным (active=false) — вход всё равно не сработает, ` +
        `пока кто-то из админов не включит его в интерфейсе или через SQL: ` +
        `UPDATE users SET active = true WHERE login = '${u.login}';`,
    );
  }
}

main()
  .catch((err) => {
    console.error("Ошибка сброса пароля:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
