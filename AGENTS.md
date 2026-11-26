# Repository Guidelines

## Project Goal

The working risk-register pilot validates the team's product risk-management process. Uptime monitoring logic is outside the pilot scope.

The standalone prototype of a team risk register, `frontend/public/risk-register.prototype.html`, walks through propose → review → publish → quarterly review → complete with simulated roles and privacy. The prototype stays standalone and keeps all data in memory.

The approved `pilot-risk-register` change defines the scope of the working pilot. Before launching it with the team, team members must pass the prototype's author and reviewer scenarios unaided and explain risk priority and the difference between a proposal and the published version. Uptime monitoring domain logic is outside the pilot scope.

## Project Structure & Module Organization

The two projects have independent builds. The root Compose file runs both projects and PostgreSQL.

- `backend/`: Java 25 LTS and Spring Boot backend for the pilot, built with Gradle Wrapper. Follow `backend/AGENTS.md`.
- `frontend/`: Server-rendered TypeScript application using Next.js App Router. It also hosts the standalone prototype under `public/`. Follow `frontend/AGENTS.md`.

These root guidelines apply to both projects. Project-specific `AGENTS.md` files supplement them within their respective directories.

## Project Documentation and OpenSpec

- **Current requirements and acceptance scenarios:** start with [the risk-register specification](openspec/specs/risk-register/spec.md). `openspec/specs/` is the source of truth for current product behavior.
- **Frontend architecture and test boundaries:** see [the pilot frontend specification](openspec/specs/pilot-frontend/spec.md).
- **Proposed changes:** read `openspec/changes/<name>/` for the proposal, spec delta, design, and tasks. Use the OpenSpec CLI from the repository root to create and validate changes. After implementation and verification, archive the change through OpenSpec to update the current specs.
- **Past decisions:** consult [the change archive](openspec/changes/archive/) for completed proposals, design decisions, tasks, and spec deltas.
- **OpenSpec context and artifact rules:** consult [openspec/config.yaml](openspec/config.yaml) when preparing an OpenSpec change.
- **HTTP-контракт пилота.** Сверяйтесь с [api/openapi.yml](api/openapi.yml) при работе с API. Если меняется наблюдаемое HTTP-поведение, сначала обновите контракт, затем код бэкенда и клиента.
- **Setup and commands:** start with the [project README](README.md). For work in a specific project, read its local guidelines and README: [frontend guidelines](frontend/AGENTS.md), [frontend setup](frontend/README.md), [backend guidelines](backend/AGENTS.md), and [backend setup](backend/README.md).
- **Prototype verification:** follow the [prototype test guide](frontend/tests/README.md) for the automated pilot suites and manual prototype acceptance.

## Testing Guidelines

Use two automated suites from `frontend/` on Node.js 24: `npm run test:components` with a contract-validating backend stub and `npm run test:e2e` with the running Spring Boot application and PostgreSQL. Run the build, lint and type checks for the affected projects. Mark a task complete only after its required checks pass. If a required check fails or cannot run, report the blocker and leave its task open.

## Commit & Pull Request Guidelines

No Git repository or commit history is available to establish conventions. Use concise imperative subjects, optionally scoped, such as `backend: migrate from Go to Java`. PRs should describe changes, link relevant issues, and report validation commands and blockers.

## Security & Configuration

Keep secrets in ignored `.env` files. Commit only placeholder values in `.env.example`. Exclude generated artifacts and installed dependencies from version control.
