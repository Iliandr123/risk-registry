# Frontend Guidelines

These instructions supplement the root `AGENTS.md` and apply to `frontend/`.

## Working pilot

Use Next.js App Router, Node.js 24 and strict TypeScript. Load the session and initial route data on the server. Keep client components for interactive forms and updates after actions. The backend enforces access and workflow rules. Follow the [frontend specification](../openspec/specs/pilot-frontend/spec.md) and [HTTP contract](../api/openapi.yml). Regenerate types with `npm run api:generate` after changes to the contract.

Routes, styles and features live in `src/app/`. Static assets live in `public/`. Keep the interface in Russian. Match existing TypeScript formatting with two-space indentation, double quotes and semicolons.

## Autonomous demonstration

Keep `public/risk-register.prototype.html` self-contained. It opens offline by double click and uses memory for all data. Participant switching simulates permissions. Keep the pure risk model separate from the DOM code. Team acceptance follows the manual scenarios in [the test guide](tests/README.md).

## Checks and development

Run `npm ci`, `npm run dev`, `npm run lint`, `npm run typecheck`, `npm run api:check` and `npm run build` from `frontend/`. Use the [component and E2E test commands](tests/README.md) for automated behavioral verification. Include screenshots for visible UI changes. Exclude `.next/` and `node_modules/` from version control.
