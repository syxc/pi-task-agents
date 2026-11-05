# MCode terminal writer source fixture

`terminal.ts.source` is an unchanged copy of:

- Repository: `MiniMax-AI/minimax-code`
- Commit: `3c21163c85a9684030cb147bfef48c6284fa3c46`
- Source: `packages/local-runtime/src/background-task/terminal.ts`
- SHA-256: `b6119204d4a78b404014cc15b2bdb2ba3ea63b3eaf106687f4e57a7673eb28b3`
- Copyright: `Copyright (c) 2026 MiniMax Code`
- License: MIT, included in the repository `LICENSE` and `NOTICE`.

The tests check the hash and compile the unchanged TypeScript module. Only its logger, delivery scheduler, and domain imports are supplied by the test harness. The domain functions are the vendored status and error functions. No user cache, network request, or test skip is needed.

The tests call the source terminal writer with scripted normal outcomes and failures. They compare plain appended content, final summaries, and late-result backfill when a stop already won the row status. Separate engine tests check publication timing and durable replay. This fixture does not test the production filesystem store or establish complete runtime equivalence.

Caller classification matters: the background runner and append completion use a failure wrapper for a rejected completion. The foreground runner catches and converts a true exception to a normal failed result before it invokes the same writer. The background runner converts a true exception caught during its explicit host shutdown to an aborted result; the append completion handler has no such conversion. A Pi transport rejection can still carry an explicitly captured normal result in `partialResult.outcome`. The engine uses this provenance, not the promise rejection alone, Error.name, partial text, or the public task row status. This internal provenance is not added to the durable task record.
