# Commerce Projection Worker Implementation Plan

- [x] Add retry policy, lease timestamps, and runnable-job storage contracts.
- [x] Add failing unit tests for backoff, retry exhaustion, due-time claims, lease recovery, and worker concurrency.
- [x] Implement the in-memory store behavior.
- [x] Implement parameterized MySQL list, claim, failure, and recovery queries.
- [x] Implement claimed-job validation and the durable worker.
- [x] Run tests, coverage, typecheck, build, production audit, and credential scan.
- [x] Update integration and operations documentation.
