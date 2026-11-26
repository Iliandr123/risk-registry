# Backend Guidelines

These instructions supplement the root `AGENTS.md` and apply to `backend/`.

## Project Goal

`backend/` is a reserved Java scaffold for the future uptime monitoring service; it was migrated from Go to Java 25 LTS because the deployment target supports Java and needs long-term support. The current stage delivers a standalone risk-register prototype in `frontend/public/` and deliberately leaves this project without service logic: no monitoring domain logic, API, server, database, or integrations. Keep `uptime.app.Main` empty and the package layout as placeholders until a later approved stage starts service design.

## Project Structure & Module Organization

This project is a Maven build targeting Java 25 LTS (`maven.compiler.release` in `pom.xml`). Use the standard Maven layout: `src/main/java/uptime/app/` for the entry point and future application wiring, `src/main/resources/` for configuration and resources, and `src/test/java/` for tests. Keep future reusable backend code under `uptime.app` subpackages. No external dependencies are declared yet.

## Build, Test, and Development Commands

Run commands from `backend/` using JDK 25 and Maven 3.9+:

- `mvn -q compile`: compile the sources.
- `mvn -q package`: build `target/uptime-backend-0.1.0.jar`; the entry point currently does nothing.
- `java -jar target/uptime-backend-0.1.0.jar`: run the packaged app; it exits immediately.
- `mvn test`: run tests; no test sources exist yet.

## Coding Style & Naming Conventions

Follow standard Java conventions: four-space indentation, lowercase packages, PascalCase classes, camelCase methods and fields, and braces on the same line. Keep the release at 25 (LTS); raise it only when the deployment target is upgraded, and change the single `maven.compiler.release` property instead of lowering code compatibility ad hoc.

## Testing Guidelines

Use JUnit 5 once backend logic exists; no test dependency or test sources are configured in this stage. Add focused behavioral tests when introducing logic and document the new tooling.

## Security & Configuration

Exclude `target/` and IDE files from version control. Keep secrets in ignored `.env` files and commit only placeholder values.
