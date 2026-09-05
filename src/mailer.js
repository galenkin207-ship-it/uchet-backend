import nodemailer from "nodemailer";
import "dotenv/config";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

// Как и VAPID-ключи для push (см. .env.example) — без этих переменных фича
// просто выключена, а не роняет сервер. Восстановление пароля по email в
// этом случае недоступно, но ручной сброс через scripts/reset-password.js на
// сервере продолжает работать как есть.
let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // 465 — SSL с самого начала соединения; 587 — STARTTLS (secure: false, апгрейд после)
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
} else {
  console.error(
    "ВНИМАНИЕ: SMTP_HOST/SMTP_USER/SMTP_PASS не заданы в .env — восстановление пароля " +
      "по email работать не будет (запросы будут молча ни к чему не приводить, это " +
      "осознанно — чтобы ответ API не выдавал, настроена почта или нет). См. .env.example.",
  );
}

export async function sendMail({ to, subject, text }) {
  if (!transporter) {
    console.error(`Не удалось отправить письмо на ${to}: SMTP не настроен (см. .env)`);
    return false;
  }
  try {
    await transporter.sendMail({ from: SMTP_FROM, to, subject, text });
    return true;
  } catch (err) {
    console.error(`Не удалось отправить письмо на ${to}:`, err);
    return false;
  }
}
