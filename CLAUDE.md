# CLAUDE.md — uchet-backend (Учёт работ, backend)

Этот файл читается Claude Code автоматически при запуске в этом репозитории.
Не удалять и не переименовывать — правила ниже критичны для безопасного деплоя
и целостности БД.

## О проекте

Node.js/Express + PostgreSQL 16. Бэкенд «Учёт работ».

- Прод: код на сервере `ifrwcmgytz` (85.198.98.136) в `/opt/uchet/server`
  — это НЕ git checkout, а авто-обновляемая директория (процесс `deploy`,
  обновляется в течение секунд после push в `main`)
- Staging: `/opt/uchet-staging/` на том же сервере, отдельная БД `uchet_db_staging`,
  сервисы `uchet-backend-staging.service` (порт 4000),
  `uchet-frontend-staging.service` (порт 4001)
- `/root/uchet-backend` — устаревший тестовый чекаут, НЕ путать с рабочим кодом
- `deploy-staging.yml` существует только в ветке `staging`

## КРИТИЧНО: безопасность веток

- Перед любой работой — проверить текущую ветку (`git branch --show-current`).
- `git pull --rebase origin main` НЕ переключает ветку — всегда явный
  `git checkout <branch>`.
- Ветка по умолчанию — `staging`, пока Константин явно не подтвердит переход
  в `main` («мержим в main»).

## КРИТИЧНО: правила базы данных

- **Любая новая таблица** сразу требует GRANT для `uchet_app`, иначе бэкенд
  падает с `aclcheck_error`:
  ```sql
  GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO uchet_app;
  GRANT USAGE, SELECT ON SEQUENCE <table>_id_seq TO uchet_app;
  ```
- `requests.status` — нативный Postgres ENUM (`request_status`). Новые значения
  только через `ALTER TYPE request_status ADD VALUE IF NOT EXISTS 'newvalue';`,
  никогда через CHECK constraint.
- Каждый файл миграции должен заканчиваться:
  ```sql
  INSERT INTO schema_migrations (filename) VALUES ('<filename>.sql') ON CONFLICT DO NOTHING;
  ```
- Админский SQL через `sudo -u postgres psql -d uchet_db` (peer auth для
  `uchet_app` напрямую не работает).

## Порядок применения миграций (всегда в этом порядке)

1. Написать код + файл миграции
2. Применить миграцию на `uchet_db_staging` через MobaXterm:
   `sudo -u postgres psql -d uchet_db_staging < migration.sql`
3. `git checkout staging` → push → автодеплой на staging
4. Константин тестирует вручную
5. Применить ту же миграцию на прод `uchet_db` через MobaXterm
6. Только после этого мерж/push в `main` → автодеплой на прод

## Правила сервера (важно для контекста, хоть Claude Code сюда не заходит)

- Процесс `www-data` НЕ может сам создавать новые поддиректории в
  `/opt/uchet/uploads` — новые директории только вручную:
  `mkdir -p <path> && chown www-data:www-data <path>` (root, через MobaXterm)
- Staging-директории (`/opt/uchet-staging/`) НЕ трогать chown на `www-data` —
  должны оставаться `deploy:deploy`

## Проверка кода перед доставкой

- `node --check src/file.js` для каждого изменённого файла
- Оставшиеся ошибки TypeScript в изолированной копии, не относящиеся к
  изменённым файлам — ожидаемы (route tree), не флагать как реальные проблемы

## Аварийный сброс пароля

`node scripts/reset-password.js <login> <new_password>` из `/opt/uchet/server`
(прод) или `/opt/uchet-staging/backend-src` (staging).

## Чего не делать без явного разрешения

- Не мержить в `main` без явного подтверждения.
- Не применять миграции на проде без подтверждения, что staging протестирован.
- Не трогать `/root/uchet-backend` — это неиспользуемый чекаут.
