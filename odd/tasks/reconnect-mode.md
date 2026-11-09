# gentle-retry — reconnect mode: resume live sessions after an internet outage

Objective: add a menu-activated feature that detects that the machine regained internet connectivity and resumes the interrupted work of the live Pi sessions, with a configurable scope (every open Pi session, or only the sessions with Reconnect mode enabled).
Branch: `feat/reconnect-mode` (based on `feat/auto-resume`); delivery: one work-unit commit per task on the feature branch; test runner: `node --experimental-strip-types --test tests/*.test.ts` plus `tsc --noEmit -p tsconfig.json`.

## Specs

- **S1** — Original request, verbatim: "Quiero implementar una nueva funcion que cuando este activa en el menu va a detectar cuando el ordenador recupere la conexion luego de una desconexion a internet y va a reanudar las sessiones que esten activas tambien va a ser posible configurar si funciona de manera globar va a reanudar todas las sesiones de pi abiertas o solo las sesiones con el modo Reconect activado. antes de hacer nada dime como lo vamos a implementar."

- **S2** — "antes de hacer nada dime como lo vamos a implementar." The implementation plan is delivered and agreed before any source change: the plan, the collision rules, the two resume paths, and the scope decision are recorded in this document before the first source write.

- **S3** — Scope of "resume the open Pi sessions", decided by the user: "Solo sesiones vivas (recomendado)" — "Solo las sesiones cuyo proceso de Pi sigue vivo (la terminal abierta). Cada proceso reanuda su propio turno cuando vuelve la red. Simple, sin procesos extra, sin cuotas surprise. Cubre el caso real: “se me cortó internet y al volver sigue trabajando”." No headless relaunch of transcripts whose process died, and no cross-process control.

- **S4** — Activation happens from the interactive menu: the feature is turned on and off from the `/gentle:retry` menu, next to the existing entries, and its state is visible in the menu, in `/gentle:retry status`, and in `/gentle:retry doctor`.

- **S5** — Detection: the extension determines that the machine regained connectivity after an internet disconnection and reacts to that transition.

- **S6** — Scope configuration: "va a ser posible configurar si funciona de manera globar va a reanudar todas las sesiones de pi abiertas o solo las sesiones con el modo Reconect activado". Two modes: `global` resumes every live Pi session that runs the extension; `session` resumes only the sessions with Reconnect mode enabled.

- **S7** — Provider timeout while the machine still has internet, verbatim: "Explicame como manejamos cuando el modelo da error de timeout pero todavia el ordenador tiene internet quiero saber si no chocan las implementaciones y demas". The existing retry path is unchanged in that case: a timeout is a provider failure, and the connectivity probe — not the error text — decides whether the machine is offline. The reconnect feature never replaces the retry path and never changes its delay, attempt count, or eligibility rules.

- **S8** — "cuando el ordenador no tiene internet el agente deja de trabajar." With the feature enabled, a turn that fails while the machine is offline waits for the connectivity to return (bounded) instead of ending, and resumes by itself. The wait is visible and cancellable with Esc.

- **S9** — Resume mechanics, verbatim: "y como reanuda enviandole un prompt ?" Two paths: the primary path continues the same run inside the `agent_before_settle` boundary without any new prompt, omitting the failed assistant message; the fallback path, used only when the turn already ended, sends a continuation prompt with `pi.sendUserMessage()`.

- **S10** — The continuation prompt of the fallback path is exactly: "The network connection was restored. Continue from where you left off without repeating completed work." It is a stable constant, and a turn that already received it is never continued twice.

- **S11** — One shared pending-resume record: auto-resume and reconnect never continue the same turn twice. The record holds the session id, the entry id, the timestamp, and the reason (`auto-resume` or `reconnect`), and the first path that continues a turn consumes it.

- **S12** — Budgets: the feature is off by default; at most 3 resume attempts before the agent makes progress again — every resume (a successful wait that continues the turn, and the continuation prompt) consumes one unit, and the budget resets when a turn completes successfully; the connectivity probe only runs while a network failure is pending, so a healthy session makes no requests.

- **S13** — Probe rules: the probe performs a real HTTP request with a timeout against a configurable endpoint (default `https://registry.npmjs.org/-/ping`), a single failed probe never declares the machine offline (two consecutive failures are required), and a successful probe clears the offline state. The watcher keeps no background timer: probes happen only when a caller asks for one, so a healthy session makes no requests and the watcher never keeps the Pi process alive.

- **S14** — Counters: `maxAttempts` counts provider attempts only, and `maxElapsedMs` excludes the time spent waiting for the connectivity, so a long outage does not exhaust the elapsed budget. The reconnect budget (waits and resumes per outage) is separate and is the one that stops the loop.

- **S15** — Tests cover: a timeout with a successful probe follows exactly today's retry path (same attempt count, same delay); a failure with a failed probe waits without consuming an attempt; a non-classified outage error waits and resumes when the connectivity returns; auto-resume and reconnect never continue the same turn; the probe does not run while the session is healthy; the feature is off by default.

- **S16** — Documentation: README, `docs/troubleshooting.md`, and `CHANGELOG.md` describe the feature, the scopes, the budgets, and the at-least-once risk of a resumed turn.

- **S17** — The previous behavior of "/gentle:retry enable [--global]", "/gentle:retry disable [--global]", "/gentle:retry status", "/gentle:retry pause", "/gentle:retry resume", "/gentle:retry auto-resume on|off [--global]", and "/gentle:retry doctor" is preserved. With the feature off, the extension behaves exactly as before.

## Tasks

| ID | Specs | Route | Status | Commit / Evidence |
| --- | --- | --- | --- | --- |
| T1 | S5, S13 | inline (parent) | done | commit `dd9011b`; 13/13 focused tests |
| T2 | S3, S6, S10, S11, S14 | inline (parent) | done | commit `85f97ce`; 22/22 focused tests, 84/84 in the affected suites |
| T3 | S4, S7, S8, S9, S15, S17 | inline (parent, after a delegated writer) | done | commit `b3a9e94`; 89/89 focused, 157/157 full suite, typecheck exit 0 |
| T4 | S16 | inline (parent) | done | commit `0eac188`; packed artifact verified, native assessment under budget |

## Log

- **L1** — Verbatim: "Quiero implementar una nueva funcion que cuando este activa en el menu va a detectar cuando el ordenador recupere la conexion luego de una desconexion a internet y va a reanudar las sessiones que esten activas tambien va ser posible configurar si funciona de manera globar va a reanudar todas las sesiones de pi abiertas o solo las sesiones con el modo Reconect activado. antes de hacer nada dime como lo vamos a implementar."

- **L2** — Plan delivered before any source write (S2): a per-process connectivity watcher, the `reconnect: "off" | "session" | "global"` setting, two resume levels, a durable marker, the affected files, and the risk table. The user then narrowed the scope and confirmed the collision rules and the two resume paths.

- **L3** — Scope decision (S3): the user selected "Solo sesiones vivas (recomendado)". Each live Pi process resumes its own turn; no process spawns or controls another session, and transcripts whose process died are out of scope.

- **L4** — Collision rules (S7, S8, S14): a provider timeout and a machine outage are two different axes. The probe decides connectivity, never the error text; a timeout with a successful probe follows today's retry path unchanged. `maxAttempts` counts provider attempts only, `maxElapsedMs` excludes offline waits, and the reconnect budget is separate. One owner of the wait: the `agent_before_settle` handler waits; the watcher only reports connectivity.

- **L5** — Resume paths (S9, S10, S11): the primary path continues the same run inside the boundary, without a new prompt, omitting the failed assistant message. The fallback path, for a turn that already ended, sends the continuation prompt with `pi.sendUserMessage()`, which always triggers a turn and is queued as a follow-up when another turn is running. Auto-resume and reconnect share one pending-resume record so the same turn is never continued twice.

- **L6** — Probe defaults: endpoint `https://registry.npmjs.org/-/ping`, two consecutive failures to declare the machine offline, the probe runs only while a network failure is pending, and the timer is unreferenced so it never keeps Pi alive.

- **L7** — Routing: the implementation is inline (the parent), one work unit per task, with the test-first rule applied per observable rule. The test conventions were mapped by a read-only explorer subagent to keep the parent's context bounded.

- **L8** — Delivery: the branch `feat/reconnect-mode` is based on `feat/auto-resume` and continues the `feature-branch-chain` strategy (L11 of the auto-resume feature). No push and no pull request are created by this implementation: both remain human decisions.

- **L9** — T1 evidence (S5, S13): RED observed first (`ERR_MODULE_NOT_FOUND` for the missing module), then GREEN with 13/13 focused tests (`node --experimental-strip-types --test tests/connectivity.test.ts`). Commit `dd9011b` (`feat: add connectivity watcher for reconnect mode`, 277 inserted lines). The test conventions were mapped by the read-only explorer `mw8jomoh-1-4ueb`: the tests import `../src/*.ts` without the `.js` suffix and register a `registerHooks` resolver that remaps the `.js` specifiers emitted by the sources.

- **L10** — Spec refinement, before the implementation of T1: S13 said "the probe timer never keeps the Pi process alive". The implementation gives the watcher no background timer at all — probes happen only inside an explicit wait, and the polling timer is cleared when the wait ends. A ref'd timer during a wait would be wrong: the pending promise alone does not keep the Node event loop alive, so the process could exit in the middle of a reconnect wait. S13 was rewritten accordingly.

- **L11** — T2 evidence (S3, S6, S10, S11, S14): the reconnect scope (`off` | `session` | `global`) is a policy field with a strict parser — an unknown value makes the file malformed and the feature stays off; the shared pending-resume record (`src/pending-resume.ts`) reads both the new record and the marker written by older auto-resume versions, so neither path continues the same turn twice; `src/retry-classification.ts` gains an additive `classifyPermanentFailure` (quota, auth, bad request) so the reconnect feature leaves the failures that waiting cannot fix alone, without changing the existing transient classification. Commit `85f97ce` (`feat: add reconnect decisions and the shared pending resume record`, 578 inserted lines). RED was observed first (the modules did not exist), then GREEN with 22/22 focused tests and 84/84 in the affected suites.

- **L12** — T3 routing incident and parent review: the delegated writer (`mw8lgag7-2-776d`) wrote the wiring (344 inserted lines in `src/extension.ts`, 40 in `src/index.ts`) and stalled before the tests; it was resumed as `mw8o9d1z-3-k3fx`. The parent reviewed the diff and found two deviations, both corrected: (1) the menu title had become `Gentle retry (current: on, reconnect: off)`, which breaks the title the user asked for and that an existing test pins — it stays exactly `Gentle retry (current: on)`; (2) the reconnect budget reset when the connectivity returned, which made the cap unreachable — every resume ended with a reachable machine, so a flapping network could resume without bound. S12 was rewritten: the budget now counts the resumes and resets only when a turn completes successfully.

- **L13** — T3 evidence: the resumed writer finished the wiring and wrote `tests/reconnect-extension.test.ts` (+538 lines). Focused run 89/89 green; the full suite `pnpm test` 157/157 green (exit 0, 72s — 49 new tests over the previous 108); `tsc --noEmit` exit 0; `node scripts/verify-package.mjs` verified the packed artifact (`gentle-retry@0.1.0`, default export function). The parent re-read the corrected regions of `src/extension.ts` (the offline detection, the fallback wait, the exactly-once prompt and the record write) and confirmed the two corrections landed. Commit `b3a9e94` (`feat: wire reconnect mode into the extension`, +927/-23 across four files). The existing test file changed only in the usage string and the new menu entries — the menu title assertion was left untouched.

- **L14** — T4 evidence and close (S16): the documentation landed in commit `0eac188` (`docs: describe the reconnect mode`, +77/-2). Native assessment over the committed range `7c26c6f..HEAD`: risk `medium`, native risk `medium` (`executable_change`, `src/extension.ts`), 7 changed paths and 1029 changed lines, `reviewDue: false` (`under_budget`) — no native review was started, and the assessment plan asks for writer self-verification only. The diff touches the shared retry boundary and the shared command surface, so an independent read-only verifier (`gentle-ai-verify`, task `mw8qapkg-4-vvbe`) checked the twelve behavioural claims of this feature against the committed code. Risk line: item 3 — the shared boundary handler and the command surface are extended by the reconnect feature, so the previous behaviour is pinned by the existing suite (108 tests unchanged and green) in addition to the 49 new ones. Delivery: the branch `feat/reconnect-mode` continues the chain `feat/npm-release` → `feat/retry-hardening` → `feat/auto-resume` → `feat/reconnect-mode`; no push and no pull request are created by this implementation.
