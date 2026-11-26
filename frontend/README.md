# Рабочий интерфейс реестра

Фронтенд использует Node.js 24, TypeScript и Next.js App Router. Сервер загружает профиль и данные текущего раздела. Интерактивные формы обращаются к API через тот же адрес.

## Разработка

Из `frontend/`:

```sh
npm ci
npm run dev
```

Откройте [http://localhost:3000](http://localhost:3000). Для входа нужен запущенный Java API и аккаунт. Для совместного запуска используйте [Docker Compose](../README.md), для отдельного API см. [README бэкенда](../backend/README.md).

`RISK_API_ORIGIN` задаёт доверенный адрес бэкенда при старте сервера Next.js. По умолчанию это `http://127.0.0.1:8080`. Через публичный адрес доступны страницы и `/api/*`.

## Проверки и сборка

```sh
npm run api:check
npm run lint
npm run typecheck
npm run build
npm start
```

`npm start` запускает автономный Node.js-сервер из production-сборки. Через `PORT` и `HOSTNAME` можно задать адрес прослушивания. Для автоматических наборов см. [руководство по тестам](tests/README.md).
