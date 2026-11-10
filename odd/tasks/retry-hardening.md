# gentle-retry — reliability, controls, and error coverage

Objective: harden gentle-retry before its public npm release while adding the requested transient-error coverage.
Branch: `feat/retry-hardening`; delivery: ordered work-unit commits on the feature branch; test runner: `node --experimental-strip-types --test tests/*.test.ts` plus `tsc --noEmit -p tsconfig.json`.

## Specs

- **S1** — Original request, verbatim: "Implementa todo eso de fomra ordenada lanza un ODD y ademas dale cobertura a estos tipos de error tambien

gentle-retry cubre estos errores ?? Error: Request timed out. Error: Request timed out. Error: Connection error. Error: Retry failed after 3 attempts: Connection error. Error: 429 {"status":429,"title":"Too Many Requests"}Error: 502 <html> <head><title>502 Bad Gateway</title></head> <body> <center><h1>502 Bad Gateway</h1></center> <hr><center>openresty</center> </body> </html>Cubre estos errores tambien Error: Retry failed after 1 attempts: 400 {"status":400,"title":"Bad Request","detail":"Function id 'eb8265c4-e47d-4047-918d-c12746cc2cee': DEGRADED function cannot be invoked"} Error: 400 {"status":400,"title":"Bad Request","detail":"Function id 'eb8265c4-e47d-4047-918d-c12746cc2cee': DEGRADED function cannot be invoked"} Error: Stream ended without finish_reason"

- **S2** — The following exact failures are transient and must be retried when the policy is on:
  - "Error: Request timed out."
  - "Error: Connection error."
  - "Error: Retry failed after 3 attempts: Connection error."
  - "Error: 429 {"status":429,"title":"Too Many Requests"}"
  - "Error: 502 <html> <head><title>502 Bad Gateway</title></head> <body> <center><h1>502 Bad Gateway</h1></center> <hr><center>openresty</center> </body> </html>"
  - "Error: Retry failed after 1 attempts: 400 {"status":400,"title":"Bad Request","detail":"Function id 'eb8265c4-e47d-4047-918d-c12746cc2cee': DEGRADED function cannot be invoked"}"
  - "Error: 400 {"status":400,"title":"Bad Request","detail":"Function id 'eb8265c4-e47d-4047-918d-c12746cc2cee': DEGRADED function cannot be invoked"}"
  - "Error: Stream ended without finish_reason"

- **S3** — Generic HTTP 400 failures remain non-transient. Only the explicitly named "DEGRADED function cannot be invoked" condition is transient among HTTP 400 failures.

- **S4** — Quota, billing, credit, spending-limit, payment, upgrade, authentication, and authorization failures remain non-transient.

- **S5** — A retry is eligible only when `agent_before_settle` reports outcome `error`. Completed and aborted boundaries never retry, even when the projected context still contains an older failed assistant message.

- **S6** — The attempt counter resets after a completed turn, an abort, a non-transient failure, a policy switch, or a session change.

- **S7** — Retry-After guidance is honored when it is available in the provider error text, using the provider value without exceeding `maxDelayMs`.

- **S8** — Backoff remains exponential with factor 1.8 and jitter proportional to the current delay, bounded by `maxDelayMs`.

- **S9** — A malformed, unreadable, or unknown-schema project policy fails closed to `off` and never falls through to an enabled global policy. A missing project policy still permits global resolution.

- **S10** — Policy delay values are positive integers and `maxDelayMs` is greater than or equal to `baseDelayMs`. Invalid values make the policy malformed and fail closed.

- **S11** — Policy and onboarding writes are atomic and work when the destination is on a different filesystem from the operating-system temporary directory.

- **S12** — The command surface supports exactly these forms:
  - "/gentle:retry enable --global"
  - "/gentle:retry disable --global"
  - "/gentle:retry status"
  - "/gentle:retry pause"
  - "/gentle:retry resume"
  - "/gentle:retry doctor"

- **S13** — Optional safety limits are disabled by default. The policy may define positive integer `maxAttempts` and `maxElapsedMs`; when reached, gentle-retry stops retrying and reports the limit. Unlimited retry remains the default.

- **S14** — Manual pause is session-scoped, prevents retries while paused, and can be resumed. The safe policy default remains `off`.

- **S15** — `/gentle:retry status` reports the effective policy, source, delay bounds, optional limits, and pause state. `/gentle:retry doctor` reports actionable configuration and installation diagnostics without exposing private credentials.

- **S16** — The published artifact remains installable with `pi install npm:gentle-retry`; CI proves the source checks, tests, and package contents on supported Node versions.

- **S17** — Publishing to npm remains a separate human-authorized action and is not executed by this implementation.

## Tasks

| ID | Specs | Route | Status | Commit / Evidence |
| --- | --- | --- | --- | --- |
| T1 | S1-S8 | delegated (context backstop) | done | commit `5b9f06d`; 10/10 classification + 24/24 extension tests |
| T2 | S9-S11 | delegated (parallel unit) | done | commit `56c3ce5`; 13/13 + 9/9 tests, typecheck pass |
| T3 | S12-S15 | delegated | done | commit `3ddc3f8`; 57/57 focused tests, typecheck pass |
| T4 | S16-S17 | delegated (parallel unit) | done | commit `2b41e4c`; 4/4 verifier tests, real packed artifact verified |
| T5 | S1-S17 | inline | done | 77/77 full suite, 72/72 focused non-stale suite, build and artifact verifier pass |

## Log

- **L1** — Verbatim: "Implementa todo eso de fomra ordenada lanza un ODD y ademas dale cobertura a estos tipos de error tambien

gentle-retry cubre estos errores ?? Error: Request timed out. Error: Request timed out. Error: Connection error. Error: Retry failed after 3 attempts: Connection error. Error: 429 {"status":429,"title":"Too Many Requests"}Error: 502 <html> <head><title>502 Bad Gateway</title></head> <body> <center><h1>502 Bad Gateway</h1></center> <hr><center>openresty</center> </body> </html>Cubre estos errores tambien Error: Retry failed after 1 attempts: 400 {"status":400,"title":"Bad Request","detail":"Function id 'eb8265c4-e47d-4047-918d-c12746cc2cee': DEGRADED function cannot be invoked"} Error: 400 {"status":400,"title":"Bad Request","detail":"Function id 'eb8265c4-e47d-4047-918d-c12746cc2cee': DEGRADED function cannot be invoked"} Error: Stream ended without finish_reason"
- **L2** — Continuation, verbatim: "Continua"
- **L3** — Accepted scope from the preceding roadmap: fix retry-boundary correctness, dropped-connection classification, policy validation/fail-closed semantics, same-filesystem atomic writes, Retry-After, proportional jitter, global/project controls, detailed status, optional safety limits, doctor diagnostics, and release verification.
- **L4** — Product interpretation recorded explicitly: the requested degraded-function HTTP 400 is transient; generic HTTP 400 remains non-transient. Optional limits default to disabled so the core promise remains unlimited retry.
- **L5** — Delivery forecast: approximately 650-900 authored changed lines across source, tests, and docs. Work-unit commits stay reviewable; push and PR creation remain human decisions.
- **L6** — Delegation incident: T1, T2, and T4 workers failed for provider-side reasons (auth, unavailable, and network respectively). No delegated source behavior change was retained for T1/T2. T4 left a partial package/CI diff but did not create its verifier script or documentation update. The parent completed the T1 RED tests and partial implementation inline, then resumed each failed worker once in its own session with the same bounded surfaces.
- **L7** — Local verification incident: TypeScript 5.9.3's compiler initially spent more than 30 seconds traversing the Pi/provider declaration graph on the NTFS-mounted workspace. After the resumed T2 worker completed, the parent reran the bounded typecheck and observed exit 0; focused Node tests remain the fast local signal, while CI on Node 22/24 remains the authoritative compatibility gate.
- **L8** — T2 evidence: policy tests 13/13 pass, onboarding tests 9/9 pass, typecheck exits 0, and `git diff --check` is clean. Native assessment returned medium risk, no independent verifier required, and an unknown native-review outcome because the untracked feature/worker files were not yet declared for the committed candidate; the assessment did not change the verification plan.
- **L9** — T1 evidence: the exact eight requested failures are covered as transient, generic HTTP 400 and quota/billing/auth failures remain non-transient, completed and aborted boundaries never retry, Retry-After is capped, and proportional jitter remains bounded. Focused verification passed 10/10 classification tests and 24/24 extension tests; work-unit commit `5b9f06d`.
- **L10** — Delegation incident: the resumed T1 worker, T4 worker, and read-only explorer all became unavailable after provider rate limiting. The parent cancelled those sessions, retained their verified partial diffs, and continued the already-authorized implementation inline within the recorded surfaces.
- **L11** — T3 evidence: the command surface now supports project/global enable and disable, detailed status, session-scoped pause and resume, and doctor diagnostics. Optional positive-integer `maxAttempts` and `maxElapsedMs` limits remain disabled when omitted. Focused verification passed 57/57 policy, extension, and onboarding tests with typecheck exit 0; work-unit commit `3ddc3f8`.
- **L12** — T4 evidence: the offline verifier packs and extracts the real artifact, checks Pi extension metadata, imports the packed extension, and checks the exact install instruction. Verification passed 4/4 focused tests and the real packed-artifact check; work-unit commit `2b41e4c`.
- **L13** — Final verification: `pnpm test` passed 77/77 tests after the build; the focused non-stale suite passed 72/72; `tsc -p tsconfig.json` exited 0; the packed-artifact verifier passed; `git diff --check` is clean. A separate `pnpm run check` invocation timed out after 120 seconds on the unsupported local Node 26 runtime, while the equivalent build command completed successfully. CI remains authoritative for the declared Node 22/24 range.
- **L14** — Native assessment was attempted for the committed range but could not create a candidate because the local native review binary was unavailable. The returned medium-risk plan still requires writer self-verification and no independent verifier; the checks in L13 satisfy that plan.
