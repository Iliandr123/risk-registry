# Backend Guidelines

These instructions supplement the root `AGENTS.md` and apply to `backend/`.

## Project Goal

`backend/` hosts the Java 25 Spring Boot API for the risk-register pilot. Use Spring JDBC for PostgreSQL and Liquibase for schema changes. Refer to the approved `pilot-risk-register` OpenSpec change and `api/openapi.yml`.

## Project Structure & Module Organization

This project uses Gradle Wrapper and targets Java 25 LTS via the toolchain in `build.gradle`. Use `src/main/java/uptime/app/` for the entry point and application wiring, `src/main/resources/` for configuration and resources. Keep reusable backend code under `uptime.app` subpackages.

## Build, Test, and Development Commands

Run commands from `backend/` using JDK 25. On Windows, use `./gradlew.bat` in place of `sh ./gradlew`.

- `sh ./gradlew classes`: compile the sources.
- `sh ./gradlew build`: package the application.
- `java -jar build/libs/uptime-backend-0.1.0.jar`: run the application with the database configuration from the README.

## Coding Style & Naming Conventions

Follow standard Java conventions: four-space indentation, lowercase packages, PascalCase classes, camelCase methods and fields, and braces on the same line. Keep the Java toolchain at 25 (LTS) until the deployment target is upgraded.

## Testing Guidelines

Behavioral verification of the real backend runs through the E2E suite with PostgreSQL in [the test guide](../frontend/tests/README.md).

## Security & Configuration

Exclude `build/`, `.gradle/` and IDE files from version control. Keep secrets in ignored `.env` files and commit only placeholder values.
