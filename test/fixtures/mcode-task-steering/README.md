# MCode steering source fixture

`steer-session.service.ts.source` is an unchanged copy of:

- Repository: `MiniMax-AI/minimax-code`
- Commit: `3c21163c85a9684030cb147bfef48c6284fa3c46`
- Path: `packages/local-runtime-v2/src/service/turn-system/execution/steering/steer-session.service.ts`
- SHA-256: `1187c463bb1e23acbd30a46132b153a9405e6b86addbea1c842dfcef3a7200f5`
- Copyright: `Copyright (c) 2026 MiniMax Code`
- License: MIT. See the repository `NOTICE` and `LICENSE` for attribution.

`turn-id.ts.source` is an unchanged copy of `packages/local-runtime/src/background-task/turn-id.ts` at the same commit. Its SHA-256 is `455c8e4c8f641688d59bc956b0a3b7ecb155c788e771a9021aa6e05fdca28bc3`. `src/vendor/mcode-adapters/task-turn-id.ts` must match it byte for byte.

The engine tests check the watched hashes, compile TypeScript, and substitute only runtime dependencies with `dependencies.mjs`. They do not edit source function bodies. No cache path, network access, or optional test skip is required.

The dependency shims provide deterministic message identity and capture. The test receipt repository uses an in-memory map. The tests compare source ordering, definitive rejection compensation, and unknown-error receipt retention. They do not test the upstream SQL implementation or claim at-least-once delivery after an uncertain commit.
