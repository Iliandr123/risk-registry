# Backend

API пилота на Java 25 LTS и Spring Boot. Spring JDBC работает с PostgreSQL, Liquibase применяет миграции при запуске.

## Локальный запуск API

Для варианта с Compose нужен Docker с Compose v2. Для запуска через Gradle также нужен JDK 25. В корне проекта скопируйте `.env.example` в `.env` (`Copy-Item .env.example .env` в PowerShell, `cp .env.example .env` в Bash). Задайте свой `POSTGRES_PASSWORD`. Для общего файла Compose и Gradle используйте длинный пароль из букв, цифр, дефисов и подчёркиваний, без кавычек. Если порты заняты, измените `LOCAL_DB_PORT` или `LOCAL_API_PORT` в этом файле.

### API и PostgreSQL в Docker Compose

Из корня проекта выполните одну команду. Compose поднимет PostgreSQL, дождётся его готовности, запустит API и дождётся его готовности.

```sh
docker compose up --build --wait backend
```

### API через Gradle Wrapper

Из корня проекта поднимите PostgreSQL, затем запустите API из каталога `backend/`.

```sh
docker compose up --wait db
cd backend
sh ./gradlew bootRun
```

В PowerShell последняя команда выглядит так: `./gradlew.bat bootRun`. Профиль `local` загружает параметры из корневого `.env`. Если контейнер API уже запущен, остановите его из корня командой `docker compose stop backend`, чтобы освободить порт.

### Проверка и остановка

Проверьте ответ `200 OK` по адресу `http://127.0.0.1:8080/api/csrf` или подставьте свой `LOCAL_API_PORT`. При запуске Liquibase создаёт таблицы в пустой базе. Остановите Gradle через Ctrl+C, а контейнеры из корня проекта командой `docker compose down`. Данные сохраняются в томе локального проекта Compose.

### Swagger UI

После локального запуска через Gradle или Compose откройте [http://localhost:8080/swagger-ui.html](http://localhost:8080/swagger-ui.html). Если меняли `LOCAL_API_PORT`, подставьте свой порт. Swagger UI загружает [контракт API](../api/openapi.yml), упакованный при сборке бэкенда. Для запросов с защищёнными cookies открывайте страницу по адресу `localhost`.

### Подключение через DBeaver

При запущенном контейнере `db` создайте новое подключение **PostgreSQL** в DBeaver и заполните поля на вкладке **Main**.

| Поле | Значение |
| --- | --- |
| Host | `127.0.0.1` |
| Port | `5432` или значение `LOCAL_DB_PORT` из `.env` |
| Database | `risk_register` |
| Username | `risk_register` |
| Password | Значение `POSTGRES_PASSWORD` из `.env` |

Нажмите **Test Connection**, при необходимости скачайте драйвер PostgreSQL по предложению DBeaver, затем нажмите **Finish**. После запуска API таблицы доступны в **Schemas → public → Tables**. [Настройки PostgreSQL в документации DBeaver](https://dbeaver.com/docs/dbeaver/Database-driver-PostgreSQL/).

Если DBeaver сообщает, что соединение отклонено, проверьте опубликованный порт командой `docker compose port db 5432`. При обычном запуске Compose подключает `compose.override.yaml` и публикует порт на `127.0.0.1`. Если раньше вы запускали стенд с `compose.local.yaml` без явного имени проекта, добавьте `-p uptime-app-local` к командам Compose, чтобы использовать тот же том PostgreSQL.

### Первый администратор

На пустой базе выполните команду один раз в приватном терминале. При запуске через Gradle используйте следующую команду из `backend/`.

```sh
sh ./gradlew bootRun --args='bootstrap-admin operator Operator'
```

В PowerShell используйте `./gradlew.bat bootRun --args='bootstrap-admin operator Operator'`.

При запуске через Compose выполните из корня проекта:

```sh
docker compose run --rm backend bootstrap-admin operator "Администратор пилота"
```

Команда печатает временный пароль администратора для первого входа в приложение.

## Сборка и проверки

Штатный запуск всех сервисов описан в [корневом README](../README.md). Для сборки JAR отдельно выполните:

```sh
sh ./gradlew build
```

Поведенческие проверки рабочего API входят в [E2E-набор](../frontend/tests/README.md). Он использует запущенное приложение и тестовую PostgreSQL.

## Подключение к отдельной PostgreSQL

Создайте пустую базу PostgreSQL и задайте переменные окружения для `sh ./gradlew bootRun` или запуска собранного JAR.

| Переменная | Значение |
| --- | --- |
| `SPRING_DATASOURCE_URL` | JDBC-адрес, например `jdbc:postgresql://localhost:5432/risk_register` |
| `SPRING_DATASOURCE_USERNAME` | Пользователь PostgreSQL с правами на миграции и операции приложения |
| `SPRING_DATASOURCE_PASSWORD` | Пароль пользователя PostgreSQL |
| `RISK_REGISTER_TEAM_TIME_ZONE` | Часовой пояс команды для даты оценки и срока пересмотра, например `Asia/Yekaterinburg`. По умолчанию `UTC` |

На пустой базе выполните команду из приватного терминала. Она применит миграции, создаст первого администратора и один раз напечатает временный пароль для личной передачи.

```sh
java -jar build/libs/uptime-backend-0.1.0.jar bootstrap-admin operator "Администратор пилота"
```

Для запуска API используйте тот же JAR с той же конфигурацией базы.

```sh
java -jar build/libs/uptime-backend-0.1.0.jar
```

Клиент подключается к API через HTTPS. Cookies сессии и CSRF помечаются `Secure`. Вход допускает до 5 попыток на логин и до 30 на сетевой адрес за 15 минут. Срок сессии 12 часов.
