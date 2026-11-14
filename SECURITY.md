# Security Policy

## Reporting

Report vulnerabilities privately to DelaySystem@tubot.lat with a
description and, if possible, a reproduction. Do not open a public
issue for unpatched security bugs.

## Scope notes

- Production posture requires `wrangler secret put AUTH_TOKEN`
  (locks chat + metrics behind a bearer) and `ALLOWED_ORIGIN`
  (locks CORS down from `*`). Without them the worker runs the
  open demo posture: fine for evaluation, not for paid traffic.
- Never commit `.dev.vars`, B2 keys, or tokens. `.dev.vars.example`
  holds empty values only.
- Model-output schema failures return 502 without executing anything;
  the worker never executes tool calls itself.
