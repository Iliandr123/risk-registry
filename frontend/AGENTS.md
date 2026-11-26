# Frontend Guidelines

These instructions supplement the root `AGENTS.md` and apply to `frontend/`.

## Project Goal

`frontend/` hosts the current deliverable: the standalone risk-register prototype `public/risk-register.prototype.html`, which walks a team through propose → review → publish → quarterly review → complete with simulated roles and privacy. The Next.js scaffold stays a placeholder for the future uptime monitoring service and is not integrated with the prototype.

Keep the prototype self-contained: one HTML file that opens by double click with no install, no server, and no network, storage, or external assets. Its `Content-Security-Policy` and a behavioral test enforce this. Data lives in memory and resets on reload; the participant switch only simulates permissions and must stay labeled as a demo that does not protect data. Keep the state transitions in the pure `RiskModel` script separate from the DOM code, and keep the UI in Russian.

The stage is complete when team members pass the author and reviewer scenarios unaided and can explain a risk's priority and the difference between a proposal and the published version. Actual team participation is validated later in a joint pilot and is not measured by these tests.

## Project Structure & Module Organization

This project uses Next.js 16 with React, TypeScript, and App Router. Routes, layouts, and global styles live in `src/app/`; static assets belong in `public/`. The `@/*` alias resolves to `src/*`. The current deliverable is a standalone page in `public/`, not a route, and does not import from `src/`.

## Build, Test, and Development Commands

Run commands from `frontend/` using Node.js 20.9+:

- `node --test tests/risk-register.prototype.test.cjs`: run the prototype's behavioral tests; no dependencies required.
- `npm install`: install dependencies; commit the resulting `package-lock.json`. Initial installation was blocked by network restrictions.
- `npm run dev`: start development at `http://localhost:3000`.
- `npm run lint` and `npm run typecheck`: check ESLint rules and TypeScript types.
- `npm run build`: create a production build; `npm start` serves it.

## Coding Style & Naming Conventions

Match existing TypeScript formatting: two spaces, double quotes, and semicolons. Use PascalCase for components and camelCase for functions and variables. Preserve Next.js filenames such as `page.tsx` and `layout.tsx`. TypeScript strict mode and Next.js ESLint rules are enabled; no separate formatter is configured.

## Testing Guidelines

The only automated tests are the risk-register prototype tests using the built-in `node:test` runner (no `npm test` script). They extract the pure model from the HTML instead of duplicating it and cover category boundaries (19/20, 39/40), critical impact 9–10, allowed transitions, proposal visibility, retention of the published version until approval, and three-calendar-month review dates with month-end and leap-year clamping. Manual verification follows the six scenario buttons in the prototype and must confirm it opens offline with no network dependencies.

## Pull Request Guidelines

Include screenshots for visible UI changes.

## Security & Configuration

Exclude `.next/` and `node_modules/` from version control.
