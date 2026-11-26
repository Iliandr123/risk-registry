# Backend

API пилота на Java 25 LTS и Spring Boot. Spring JDBC работает с PostgreSQL, Liquibase применяет миграции при запуске.

Выполняйте команды из каталога `backend/` с JDK 25. В Windows используйте `./gradlew.bat` вместо `sh ./gradlew`. При первом запуске Wrapper скачивает закреплённую версию Gradle.

## Сборка и тесты

```sh
sh ./gradlew build
```

JUnit запускает HTTP-проверки через MockMvc. Testcontainers поднимает отдельный PostgreSQL 17, поэтому для `build` и `test` нужен работающий Docker. ArchUnit проверяет границу между `accounts` и `risks`. Чтобы собрать исполняемый JAR отдельно, используйте `sh ./gradlew bootJar`.

## Запуск

Создайте пустую базу PostgreSQL и задайте переменные окружения для приложения.

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
