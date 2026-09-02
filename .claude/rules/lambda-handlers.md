---
paths:
  - "src/**/*lambda*.ts"
---

# Lambda handler conventions

These apply to every Lambda entry point (`src/mcp/lambda.ts`, `src/digest/lambda.ts`, `src/sleeper/sync-lambda.ts`). Handlers live in their subsystem's directory, not a shared `handlers/` folder — the subsystem owns its entry point.

- **Handlers are thin adapters.** Translate the event shape, call the subsystem's real function, return. All behavior lives in the shared module (`http.ts`, `run.ts`, `players.ts`) so the local script path and the Lambda path run the same code.
- **Cold starts:** heavy AWS SDK clients are lazy — dynamic `import()` at first use, cached on the instance (see `SecretsManagerTokenStore` in `src/yahoo/token-store.ts`). Don't add module-scope work that every cold start pays for.
- **Env vars are the only config channel.** Read `process.env.X` at point of use with an explicit fallback or a loud error; never bake values in. Lambda-vs-local branching keys off presence (`AWS_LAMBDA_FUNCTION_NAME`, `HISTORY_BUCKET`, `TOKENS_SECRET_ID`), not a NODE_ENV flag.
- **Logging shape:** one `JSON.stringify` line per machine-readable event, tagged (e.g. `tag: "MUFF_RUN"`) so Logs Insights can filter it. Multi-line dumps are not queryable. Human-readable context can be separate plain `console.log` lines.
- **Failures are loud.** Let errors throw — a failed invocation in CloudWatch IS the alert. Never swallow an error to "keep the Lambda green".
- **No secrets in code or logs.** Yahoo tokens come from Secrets Manager (`muff/yahoo-tokens`); the MCP bearer token from env. Never log token values or write secrets to S3.
