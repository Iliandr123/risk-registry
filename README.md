# Реестр рисков

Рабочий пилот использует серверный Next.js на TypeScript, API на Java 25 и PostgreSQL. Архитектура и критерии проверки описаны в [OpenSpec](openspec/specs/pilot-frontend/spec.md). Автономный учебный прототип открывается отдельно из [HTML-файла](frontend/public/risk-register.prototype.html).

## Локальный запуск

Для разработки API используйте [запуск через Gradle или Compose и подключение DBeaver](backend/README.md#локальный-запуск-api).

Чтобы запустить весь пилот с прямым доступом к API и PostgreSQL с этого компьютера, подготовьте `.env`, как описано ниже, и выполните из корня:

```sh
docker compose -p uptime-app -f compose.yaml -f compose.local.yaml up --build --wait
```

По умолчанию интерфейс доступен на `localhost:3000`, API на `127.0.0.1:8080`, PostgreSQL на `127.0.0.1:5432`. Если пилот уже запущен под другим именем, укажите его через `-p`. Имя проекта можно посмотреть в `docker compose ls`.

## Запуск всего пилота

Нужен Docker с Compose v2. Скопируйте `.env.example` в `.env`, задайте пароль базы и при необходимости измените порт и часовой пояс команды. Из корня проекта выполните:

```sh
docker compose up --build --wait
docker compose run --rm backend bootstrap-admin operator "Администратор пилота"
```

Создание администратора выполняется один раз на пустой базе. Сохраните временный пароль из вывода команды и войдите на [http://localhost:3000](http://localhost:3000). При первом входе приложение запросит новый пароль. Используйте адрес `localhost` для проверки защищённых cookies при локальном запуске.

`docker compose stop` останавливает сервисы. Повторный `docker compose up --wait` использует существующий том PostgreSQL.

Для командного стенда направьте внутренний HTTPS-прокси на `127.0.0.1:3000` и используйте один адрес для страниц и `/api/*`. Прокси должен сохранять Set-Cookie и учитывать Cache-Control. Перед обновлением сохраните копию PostgreSQL и версии образов. После обновления проверьте состояние через `docker compose ps` и вход с тестовым аккаунтом. При откате верните предыдущие образы и конфигурацию. При несовместимой миграции понадобится совместимая копия БД и сверка аккаунтов и сессий до открытия доступа.

## Разработка и проверки

- [Фронтенд и его команды](frontend/README.md)
- [Запуск Spring Boot отдельно](backend/README.md)
- [Компонентные и E2E-тесты](frontend/tests/README.md)

HTTP-контракт находится в [api/openapi.yml](api/openapi.yml). Для проверки схемы из корня используйте `python -m openapi_spec_validator api/openapi.yml` с пакетом `openapi-spec-validator==0.7.2`. После изменений контракта выполните `npm run api:generate` из `frontend/`.
