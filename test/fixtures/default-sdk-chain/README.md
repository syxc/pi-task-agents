# Default SDK chain regressions

`scenarios.mjs` runs the production TaskEngine and default Pi child factory with
owned temporary sessions. Only the model responses are scripted; no model service,
user credentials, or deployment service is used.

The cases cover independent history, returned and thrown failures, cancellation,
terminal output, and request replay. Native tools come from the Pi SDK. The parent
wrapper requires every scenario to pass and propagates subprocess failures.

These are plugin-owned regression cases, not unchanged upstream source fixtures.
