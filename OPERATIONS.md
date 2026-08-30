# InvestPal Bot Engine Operations

## Local development

```bash
npm install
npm run build
npm run dev
```

The API listens on `PORT` (default `4000`). Development may omit `API_AUTH_TOKEN`; production must not.

## Production prerequisites

Set `NODE_ENV=production`, `API_AUTH_TOKEN`, `STORE_SECRET`, and `DATABASE_URL`. Set `EXECUTION_JOURNAL_PATH` and `TRADING_CONTROL_PATH` to the persistent disk. The Render start command applies `migrations/001_trading_core.sql` before starting the API.

## Readiness and safety

- `GET /health` is a liveness check and does not prove broker or database readiness.
- `GET /ready` is the deployment readiness check; production requires API auth and database configuration.
- `GET /api/emergency-stop` reports the global stop state.
- `POST /api/emergency-stop` blocks new starts and broker submissions, then stops the active engine.
- `DELETE /api/emergency-stop` clears the stop after operator review.
- `POST /api/reconciliation/run` compares local execution records with Deriv contract state.
- `POST /api/paper/execute` creates a risk-gated in-memory paper execution.
- `POST /api/paper/settle/:executionId` settles a paper execution explicitly for testing.

## Validation

Run `npm run test:risk` before deployment. This builds strict TypeScript and runs the risk-gate tests. A real database is required for `npm run db:migrate`; the command fails closed when `DATABASE_URL` is missing.

Live trading requires a verified Deriv connection and explicit account authorization. Paper/demo execution adapters are not yet implemented; do not label current runs as paper or simulation.
