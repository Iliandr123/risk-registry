# Repository Guidelines

## Project Goal

The repository was originally scaffolded for an uptime monitoring service, with a Go backend and a Next.js frontend. Work has since pivoted: the current stage validates the team's product risk-management process before the service is designed.

The active deliverable is a standalone prototype of a team risk register, `frontend/public/risk-register.prototype.html`. It walks through propose → review → publish → quarterly review → complete with simulated roles and privacy, and keeps all data in memory. The prototype stays standalone: no authentication, server, database, or integrations.

The backend scaffold was migrated from Go to Java 25 LTS (Maven) because the deployment target supports Java and needs long-term support; it still holds no service logic. Until the prototype stage closes, do not implement uptime monitoring domain logic or build service infrastructure. The stage closes when team members can pass the author and reviewer scenarios unaided and explain risk priority and the difference between a proposal and the published version; actual team participation is checked later in a joint pilot, not by automated tests.

## Project Structure & Module Organization

This repository contains two independent projects, each with its own README and build configuration. No shared workspace tooling exists.

- `backend/`: Java 25 LTS (Maven) scaffold for the future monitoring service, intentionally empty in this stage. Follow `backend/AGENTS.md`.
- `frontend/`: Next.js application that also hosts the current deliverable, the standalone risk-register prototype under `public/`. Follow `frontend/AGENTS.md`.

These root guidelines apply to both projects. Project-specific `AGENTS.md` files supplement them within their respective directories.

## Project Documentation and OpenSpec

- **Current requirements and acceptance scenarios:** start with [the risk-register specification](openspec/specs/risk-register/spec.md). `openspec/specs/` is the source of truth for current product behavior.
- **Proposed changes:** read `openspec/changes/<name>/` for the proposal, spec delta, design, and tasks. Use the OpenSpec CLI from the repository root to create and validate changes. After implementation and verification, archive the change through OpenSpec to update the current specs.
- **Past decisions:** consult [the change archive](openspec/changes/archive/) for completed proposals, design decisions, tasks, and spec deltas.
- **OpenSpec context and artifact rules:** consult [openspec/config.yaml](openspec/config.yaml) when preparing an OpenSpec change.
- **HTTP-контракт пилота.** Сверяйтесь с [api/openapi.yml](api/openapi.yml) при работе с API. Если меняется наблюдаемое HTTP-поведение, сначала обновите контракт, затем код бэкенда и клиента.
- **Setup and commands:** start with the [project README](README.md). For work in a specific project, read its local guidelines and README: [frontend guidelines](frontend/AGENTS.md), [frontend setup](frontend/README.md), [backend guidelines](backend/AGENTS.md), and [backend setup](backend/README.md).
- **Prototype verification:** follow the [prototype test guide](frontend/tests/README.md) for the automated check, manual scenarios, and team acceptance.

## Testing Guidelines

The risk-register prototype has focused behavioral tests using the built-in Node.js `node:test` runner: run `node --test tests/risk-register.prototype.test.cjs` from `frontend/`. The tests extract the pure state model from the HTML rather than duplicating it, and cover category boundaries (19/20 and 39/40), critical impact 9–10, allowed transitions, proposal visibility, retention of the published version until approval, and the three-calendar-month review date.

Add or update focused automated tests for the key scenarios and relevant edge cases of new or changed behavior. Run the required checks for the affected parts of the project from the relevant project directory. Mark a task complete only after all required checks pass. If a required check fails or cannot run, report the failure or blocker and leave the task open. Document any new test tooling.

## Commit & Pull Request Guidelines

No Git repository or commit history is available to establish conventions. Use concise imperative subjects, optionally scoped, such as `backend: migrate from Go to Java`. PRs should describe changes, link relevant issues, and report validation commands and blockers.

## Security & Configuration

Keep secrets in ignored `.env` files. Commit only placeholder values in `.env.example`. Exclude generated artifacts and installed dependencies from version control.
