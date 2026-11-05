# MCP test fixtures

`owned-server.mjs` provides a local stdio server for native Pi SDK integration tests.
`offline-guard.mjs` rejects network access in test subprocesses.

Tests own their temporary configuration and server processes. These fixtures do not
implement a second MCP client or claim MCode runtime equivalence.
