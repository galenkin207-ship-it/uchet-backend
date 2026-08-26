import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import "dotenv/config";

import { attachUser } from "./auth.js";
import { authRouter } from "./routes/auth.js";
import { objectsRouter, employeesRouter, unitsRouter, workTypesRouter } from "./routes/directories.js";
import { recordsRouter } from "./routes/records.js";
import { requestsRouter } from "./routes/requests.js";
import { usersRouter } from "./routes/users.js";
import { pinnedObjectsRouter } from "./routes/pinned-objects.js";
import { hiddenObjectsRouter } from "./routes/hidden-objects.js";
import { brigadesRouter } from "./routes/brigades.js";
import { pushRouter } from "./routes/push.js";
import { notificationReadsRouter } from "./routes/notification-reads.js";
import { auditRouter } from "./routes/audit.js";

export const app = express();

// Если фронтенд и бэкенд на одном домене за одним nginx (рекомендуемая
// схема — см. README деплоя), CORS вообще не нужен, credentials идут
// через обычные same-origin cookies. CORS_ORIGIN оставлен на случай
// раздельных доменов/локальной разработки.
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(attachUser);

app.get("/api/health", (_req, res) => res.json({ ok: true, version: "1.0.1" }));

app.use("/api", authRouter);
app.use("/api/objects", objectsRouter);
app.use("/api/employees", employeesRouter);
app.use("/api/units", unitsRouter);
app.use("/api/work-types", workTypesRouter);
app.use("/api/records", recordsRouter);
app.use("/api/requests", requestsRouter);
app.use("/api/users", usersRouter);
app.use("/api/pinned-objects", pinnedObjectsRouter);
app.use("/api/hidden-objects", hiddenObjectsRouter);
app.use("/api/brigades", brigadesRouter);
app.use("/api/push", pushRouter);
app.use("/api/notification-reads", notificationReadsRouter);
app.use("/api/audit-log", auditRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
