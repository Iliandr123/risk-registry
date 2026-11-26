# Uptime App

Два независимых проекта:

- `backend/` — API пилота на Java 25 LTS, Spring Boot и PostgreSQL. Сборка через Gradle Wrapper.
- `frontend/` — минимальный каркас Next.js 16 с TypeScript и App Router.

Команды запуска находятся в README каждого проекта.

## Проверка HTTP-контракта пилота

Для локальной проверки [контракта OpenAPI](api/openapi.yml) выполните из корня
репозитория в виртуальном окружении Python 3.13 те же команды, что и в CI.

```sh
python -m pip install openapi-spec-validator==0.7.2
openapi-spec-validator api/openapi.yml
```
