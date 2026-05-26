# Notification Preferences Service

REST API сервис для управления предпочтениями уведомлений пользователей и принятия решения об их доставке. Построен на **Fastify**, **PostgreSQL**, **Redis** и **TypeScript**.

> English version: [README.md](./README.md)

---

## Содержание

- [Обзор](#обзор)
- [Архитектура](#архитектура)
- [Быстрый старт](#быстрый-старт)
- [Локальная разработка](#локальная-разработка)
- [Аутентификация](#аутентификация)
- [API Reference](#api-reference)
- [Тестирование](#тестирование)
- [Observability](#observability)
- [Масштабирование](#масштабирование)

---

## Обзор

Сервис отвечает на один вопрос: **можно ли отправить это уведомление прямо сейчас?**

Каскад проверок (от наивысшего приоритета к низшему):

| Шаг | Условие | Результат |
|-----|---------|-----------|
| 1 | Глобальная политика блокирует этот тип/канал/регион | `deny: blocked_by_global_policy` |
| 2 | Пользователь явно отключил этот тип/канал | `deny: disabled_by_user` |
| 3 | Текущее время попадает в тихий час пользователя *(только marketing-типы)* | `deny: quiet_hours` |
| 4 | Пользователь явно включил этот тип/канал | `allow: user_preference` |
| 5 | Фолбэк на системные дефолты | `allow/deny: default_preference` |

**Дефолтные настройки** (заполняются при первом запуске):

| Тип | Канал | По умолчанию |
|-----|-------|--------------|
| `transactional_email` | email | ✅ разрешено |
| `marketing_email` | email | ❌ запрещено |
| `transactional_sms` | sms | ✅ разрешено |
| `marketing_sms` | sms | ❌ запрещено |
| `transactional_push` | push | ✅ разрешено |
| `marketing_push` | push | ❌ запрещено |

---

## Архитектура

```
src/
├── domain/             # Ядро бизнес-логики — без зависимостей от фреймворков
│   ├── types.ts            NotificationType, Channel, Region, EvaluateResult
│   ├── entities/           UserPreference, GlobalPolicy, QuietHours
│   ├── repositories/       Интерфейсы репозиториев (без реализаций)
│   └── services/
│       └── EvaluationService.ts   5-шаговый каскад evaluate
├── application/
│   └── use-cases/          GetUserPreferences, UpdateUserPreferences, EvaluateNotification
├── infrastructure/
│   ├── db/                 PostgreSQL через pg + Drizzle схема, миграции
│   ├── cache/              RedisCache (cache-aside), NoopCache для тестов
│   ├── metrics/            prom-client счётчики и гистограммы
│   └── logger/             Pino — структурированный JSON лог
├── api/                # HTTP-слой (Fastify 4)
│   ├── routes/             preferences, evaluate, health
│   ├── middleware/         JWT-авторизация, Correlation ID (X-Request-ID)
│   ├── swagger.ts          OpenAPI 3.0 спека (@fastify/swagger)
│   └── server.ts
└── config/             Zod-валидированный env-конфиг
```

**Ключевые архитектурные решения:**
- **Dependency Inversion** — `EvaluationService` зависит только от интерфейсов репозиториев, не от реализаций.
- **Cache-aside с Redis** — предпочтения пользователя кешируются на 60 с, глобальные политики на 300 с; инвалидируются при записи.
- **Stateless приложение** — всё состояние хранится в PostgreSQL и Redis; можно запускать любое число реплик.
- **Идемпотентность** — `POST /preferences` использует `ON CONFLICT DO UPDATE`; повторные запросы безопасны.
- **Тихие часы через Luxon** — корректная работа с IANA-таймзонами и переходом через полночь.

---

## Быстрый старт

### Требования

- [Docker](https://docs.docker.com/get-docker/) с Compose v2

### Запуск полного стека

```bash
git clone <repo-url>
cd notification-service

docker compose up --build
```

Будет запущено:

| Сервис | URL | Доступ |
|--------|-----|--------|
| API (через Nginx) | http://localhost:3000 | JWT-токен (см. ниже) |
| Swagger UI | http://localhost:3000/docs | без токена |
| Prometheus | http://localhost:9090 | — |
| Grafana | http://localhost:3001 | admin / admin |

Nginx стоит перед контейнерами приложения и балансирует запросы между репликами. Миграции и сид дефолтных настроек выполняются автоматически при старте контейнера `app`.

### Остановка

```bash
# Остановить контейнеры, данные сохранить
docker compose down

# Остановить и удалить все данные
docker compose down -v
```

---

## Локальная разработка

```bash
# 1. Установить зависимости
npm install

# 2. Запустить только инфраструктуру
docker compose up postgres redis -d

# 3. Задать переменные окружения
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/notifications
export REDIS_URL=redis://localhost:6379
export JWT_SECRET=local-dev-secret-minimum-32-characters
export PORT=3000

# 4. Собрать и прогнать миграции
npm run build && npm run migrate

# 5. Dev-сервер с горячей перезагрузкой
npm run dev
```

### Сборка для продакшена

```bash
npm run build   # компилирует TypeScript в dist/
npm start       # запускает dist/index.js
```

### Линтинг

```bash
npm run lint       # tsc --noEmit + eslint
npm run lint:fix   # автоисправление eslint
```

---

## Аутентификация

Все эндпоинты, кроме `/healthz`, `/readyz`, `/metrics` и `/docs`, требуют **Bearer JWT-токен** (HS256, подписанный `JWT_SECRET`).

### Сгенерировать токен

```bash
node -e "
const crypto = require('crypto');
const SECRET = process.env.JWT_SECRET ?? 'change-me-to-a-random-secret-at-least-32-chars';
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const now = Math.floor(Date.now() / 1000);
const payload = b64url(JSON.stringify({ sub: 'my-service', iat: now, exp: now + 3600 }));
const sig = crypto.createHmac('sha256', SECRET).update(header+'.'+payload).digest('base64')
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
console.log(header + '.' + payload + '.' + sig);
"
```

Сохранить в переменную:
```bash
export TOKEN=$(node -e "...")   # тот же скрипт
```

### Использование в Swagger UI

1. Открыть http://localhost:3000/docs
2. Нажать **Authorize** (замок вверху справа)
3. Вставить токен — **без префикса `Bearer `** (Swagger добавляет его сам)
4. Нажать **Authorize**, закрыть диалог

---

## API Reference

### GET /users/:userId/preferences

Возвращает смёрженный вид предпочтений пользователя: явные настройки имеют приоритет, остальные берутся из системных дефолтов.

```bash
curl http://localhost:3000/users/alice/preferences \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "userId": "alice",
  "preferences": [
    { "notificationType": "transactional_email", "channel": "email", "enabled": true,  "source": "default" },
    { "notificationType": "marketing_email",     "channel": "email", "enabled": false, "source": "default" },
    { "notificationType": "transactional_sms",   "channel": "sms",   "enabled": true,  "source": "default" },
    { "notificationType": "marketing_sms",       "channel": "sms",   "enabled": false, "source": "default" },
    { "notificationType": "transactional_push",  "channel": "push",  "enabled": true,  "source": "default" },
    { "notificationType": "marketing_push",      "channel": "push",  "enabled": false, "source": "default" }
  ],
  "quietHours": null
}
```

Поле `source`: `"user"` — явная настройка пользователя, `"default"` — системный дефолт.

---

### POST /users/:userId/preferences

Обновление предпочтений (идемпотентно). Принимает `preferences` и/или `quietHours` — можно передавать одно или оба поля.

**Отключить маркетинговые письма и задать тихие часы:**

```bash
curl -X POST http://localhost:3000/users/alice/preferences \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "preferences": [
      { "notificationType": "marketing_email", "channel": "email", "enabled": false },
      { "notificationType": "transactional_sms", "channel": "sms", "enabled": true }
    ],
    "quietHours": {
      "startHour": 22,
      "startMinute": 0,
      "endHour": 8,
      "endMinute": 0,
      "timezone": "Europe/Moscow"
    }
  }'
```

```json
{
  "userId": "alice",
  "updatedCount": 2,
  "quietHours": {
    "startHour": 22,
    "startMinute": 0,
    "endHour": 8,
    "endMinute": 0,
    "timezone": "Europe/Moscow"
  }
}
```

**Допустимые типы уведомлений:** `transactional_email`, `marketing_email`, `transactional_sms`, `marketing_sms`, `transactional_push`, `marketing_push`

**Допустимые каналы:** `email`, `sms`, `push`, `messenger`

**Поля quietHours:**
- `startHour` / `endHour` — целое число 0–23
- `startMinute` / `endMinute` — целое число 0–59
- `timezone` — любая IANA-строка таймзоны (например, `UTC`, `Europe/Moscow`, `Asia/Yekaterinburg`)
- Переход через полночь поддерживается (например, 22:00–06:00)

---

### POST /evaluate

Оценивает, можно ли отправить уведомление. Прогоняет полный 5-шаговый каскад.

```bash
curl -X POST http://localhost:3000/evaluate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "alice",
    "notificationType": "marketing_email",
    "channel": "email",
    "region": "EU",
    "datetime": "2026-06-01T23:30:00Z"
  }'
```

```json
{
  "decision": "deny",
  "reason": "quiet_hours"
}
```

**Поля запроса:**

| Поле | Тип | Описание |
|------|-----|----------|
| `userId` | string | Идентификатор получателя |
| `notificationType` | enum | Один из 6 типов уведомлений |
| `channel` | enum | `email`, `sms`, `push` или `messenger` |
| `region` | string | `EU`, `US`, `APAC`, `LATAM`, `OTHER` или произвольная строка |
| `datetime` | ISO 8601 | Момент времени для оценки (используется при проверке тихих часов) |

**Возможные причины решения:**

| Причина | Решение | Смысл |
|---------|---------|-------|
| `blocked_by_global_policy` | deny | Политика администратора блокирует тип/канал/регион |
| `disabled_by_user` | deny | Пользователь явно отключил уведомление |
| `quiet_hours` | deny | Время запроса попадает в тихий час пользователя |
| `user_preference` | allow | Пользователь явно включил уведомление |
| `default_preference` | allow / deny | Нет явной настройки — применяется системный дефолт |

---

### GET /healthz

Liveness probe. Возвращает `200` пока процесс жив.

```bash
curl http://localhost:3000/healthz
# {"status":"ok"}
```

### GET /readyz

Readiness probe. Возвращает `200` при доступности PostgreSQL и Redis, `503` если что-то недоступно.

```bash
curl http://localhost:3000/readyz
# {"status":"ok","db":"ok","redis":"ok"}
```

### GET /metrics

Метрики в формате Prometheus. Используются встроенным контейнером Prometheus.

---

## Тестирование

### Unit-тесты

Не требуют инфраструктуры. Запускаются изолированно.

```bash
npm run test:unit
```

Покрытие: доменная логика (`EvaluationService`, `QuietHours`, каскад), use-cases, Redis-кеш, валидация входных данных, JWT middleware, обработчики роутов с mock use-cases.

### Integration-тесты

Требуют работающий PostgreSQL. Тестовая база **создаётся автоматически** при первом запуске — никакого ручного создания не нужно.

```bash
# Запустить только базу данных
docker compose up postgres -d

# Запустить integration-тесты (тестовая БД создаётся автоматически)
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/notifications_test \
  npm run test:integration
```

Покрытие: сквозные сценарии с реальными репозиториями — блокировка глобальной политикой, отключение пользователем, тихие часы, явное включение, дефолтный фолбэк.

### E2E-тесты

Бьют в **реально запущенный сервис** на `localhost:3000` (через Nginx). Требуют запущенного Docker Compose стека.

```bash
# Сначала поднять полный стек
docker compose up -d

# Запустить e2e-тесты
npm run test:e2e
```

Если сервис недоступен — все e2e-тесты пропускаются gracefully с предупреждением в консоли. Безопасно запускать в CI без стека.

**Переопределить базовый URL:**
```bash
E2E_BASE_URL=http://staging.example.com npm run test:e2e
```

**Что покрывает e2e-сьют (`tests/e2e/api.test.ts`):**
- Health-пробы (`/healthz`, `/readyz`)
- 401 без токена, 401 с невалидным токеном, 200 с валидным токеном
- Swagger UI доступен без авторизации (`/docs`, `/docs/json`)
- GET preferences — структура ответа, эхо `X-Request-ID`
- POST preferences — сохранение настройки, чтение обратно, round-trip тихих часов, 400 на невалидный ввод
- POST evaluate — allow по дефолту, deny при отключении пользователем, deny в тихие часы, 400 на невалидный запрос

### E2E-тесты масштабирования

Проверяют stateless-поведение при нескольких репликах (`tests/e2e/scaling.test.ts`).

```bash
# Сначала масштабировать до 3 реплик
docker compose up --scale app=3 -d

# Запустить все e2e-тесты (api + scaling)
npm run test:e2e
```

**Что покрывает сьют масштабирования:**
- Nginx проксирует запросы и прокидывает `X-Request-ID`
- Запись видна на всех 20 конкурентных чтениях (попадающих на разные реплики)
- Вторая запись перекрывает первую — все чтения отражают актуальное значение
- Тихие часы, заданные через одну реплику, видны через все остальные
- Результат evaluate консистентен между репликами после изменения настроек
- `/healthz` возвращает 200 под нагрузкой из 50 конкурентных запросов

### Запустить все тесты

```bash
npm test
```

Запускает unit + integration тесты. E2E — отдельный шаг, так как требует поднятого стека.

---

## Observability

| Сигнал | Детали |
|--------|--------|
| Структурированные логи | Pino JSON, одна строка на запрос с `reqId` (correlation ID) |
| `X-Request-ID` | Эхо из заголовка запроса или автогенерация (UUID v4) |
| Метрики Prometheus | Доступны по `/metrics` |
| Дашборд Grafana | Авто-provisioning по адресу http://localhost:3001 |

**Ключевые метрики Prometheus:**

- `http_request_duration_seconds` — гистограмма латентности по методу, роуту, статус-коду
- `notifications_evaluated_total` — счётчик evaluate по decision, reason, channel, type
- `cache_hits_total` / `cache_misses_total` — счётчики попаданий/промахов Redis-кеша

### Grafana

1. Открыть **http://localhost:3001**
2. Войти: логин **admin**, пароль **admin**
3. Нажать **Dashboards** в левом сайдбаре
4. Открыть **Notification Service**

На дашборде три секции:

| Секция | Панели |
|--------|--------|
| **Evaluations** | Rate решений (allow vs deny), breakdown по причинам deny |
| **HTTP Performance** | Request rate по роутам, перцентили латентности (p50 / p95 / p99) |
| **Cache Performance** | Cache hit rate по типу ключа, rate операций кеша |

Панели используют `rate([5m])` — им нужен трафик для отображения данных. Сгенерируй его:

```bash
npm run load                   # 6 раундов, ~70 запросов каждый
ROUNDS=20 npm run load         # больше точек на графиках
```

Если панели показывают "No data" — переключи диапазон времени на **Last 15 minutes**, подожди один цикл скрейпа Prometheus (15 с) и обнови страницу.

---

## Масштабирование

### Несколько реплик

Nginx уже включён в Docker Compose стек и балансирует нагрузку между контейнерами приложения через внутренний DNS Docker (round-robin). Контейнеры приложения не имеют прямого маппинга на хост — весь трафик идёт через Nginx на порту 3000.

```bash
# Запустить 3 реплики (Nginx балансирует автоматически)
docker compose up --scale app=3 -d

# Уменьшить обратно
docker compose up --scale app=1 -d
```

Приложение stateless: всё состояние хранится в PostgreSQL и Redis, поэтому каждая реплика всегда отдаёт одинаковые данные.

### Проверка statelessness (e2e-тесты масштабирования)

```bash
# При запущенных 3 репликах:
npm run test:e2e
```

Сьют `tests/e2e/scaling.test.ts` делает 10–20 конкурентных запросов после каждой записи и проверяет, что все ответы отражают актуальные данные, независимо от того, какая реплика обработала запрос.

### Чеклист для Kubernetes

- `GET /healthz` → `livenessProbe`
- `GET /readyz` → `readinessProbe`
- Конфиг через `ConfigMap` / `Secret` (переменные окружения)
- Заменить Nginx на k8s `Service` (type `ClusterIP` + `Ingress`)
- PgBouncer как sidecar или отдельный Deployment (профиль уже есть в `docker-compose.yml`)
- Redis → Redis Sentinel или Redis Cluster для HA
- `HorizontalPodAutoscaler` по CPU или кастомной метрике

### PgBouncer (опционально, уже настроен)

```bash
# Запустить стек с PgBouncer перед Postgres
docker compose --profile pgbouncer up -d

# Указать приложению адрес PgBouncer (порт 6432)
DATABASE_URL=postgresql://postgres:postgres@localhost:6432/notifications
```

---

## Лицензия

MIT License — см. [LICENSE](./LICENSE).
