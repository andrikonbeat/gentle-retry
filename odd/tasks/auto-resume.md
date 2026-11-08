# gentle-retry — auto-resume an interrupted turn after reopening

Objective: add the P2 session-resume capability approved by the user: when a session is reopened and its last turn was interrupted, gentle-retry continues that turn by itself, behind an explicit opt-in that is off by default.
Branch: `feat/auto-resume` (based on `feat/retry-hardening`); delivery: one work-unit commit on the feature branch; test runner: `node --experimental-strip-types --test tests/*.test.ts` plus `tsc --noEmit -p tsconfig.json`.

## Specs

- **S1** — Original request, verbatim: "Implementar P2 en gentle-retry"

- **S2** — Accepted option, verbatim: "**Implementar P2 en gentle-retry** — opción `autoResume` (default off) que al reabrir retoma el turno interrumpido. *(recomendado: encaja en el dominio de la extensión y reutiliza clasificación, backoff y escrituras atómicas ya hechas)*"

- **S3** — Auto-resume is opt-in and disabled by default. The retry policy file gains an optional `autoResume` boolean. A policy file without the field keeps auto-resume disabled, and a malformed or unreadable policy file fails closed with auto-resume disabled.

- **S4** — The trigger is the `session_start` event with reason "resume" or "startup". The extension inspects the session branch through `ctx.sessionManager.getBranch()`. The reasons "new" and "fork" never trigger auto-resume.

- **S5** — A turn counts as interrupted when the last user message has no assistant message after it, or when the last assistant message after it carries `stopReason` "pending" or "toolUse". An assistant message with `stopReason` "stop", "length", "aborted", "error", or "deferred" ends the turn and never triggers auto-resume.

- **S6** — Auto-resume sends exactly one continuation message through `pi.sendUserMessage()`, modeled on OpenCode's `CONTINUE_AFTER_SERVER_RESTART`: "The server restarted while you were working. Continue from where you left off without repeating completed work."

- **S7** — Idempotency: a durable marker holding the session id, the interrupted turn's entry id, and a timestamp, written with the existing `src/atomic-write.ts`, prevents continuing the same turn twice. The marker lives in the Gentle Shell config home next to the other gentle-retry state and never contains message content.

- **S8** — The option is configured through the existing command surface and reported by the existing diagnostics:
  - "/gentle:retry auto-resume on"
  - "/gentle:retry auto-resume off"
  - "/gentle:retry auto-resume on --global"
  - "/gentle:retry auto-resume off --global"
  - "/gentle:retry status"
  - "/gentle:retry doctor"

- **S9** — The at-least-once risk is explicit: a turn that died after running a tool and before recording the result may repeat that side effect. Auto-resume therefore stays off by default and requires an explicit opt-in.

- **S10** — Tests cover: the default disabled state does nothing; an enabled policy with an interrupted turn sends exactly one message; an aborted assistant never sends; an existing marker prevents a duplicate continuation; the reasons "new" and "fork" never act.

- **S11** — Auto-resume only runs in an interactive TUI session (`ctx.mode === "tui"`). Headless and print runs never auto-resume.

- **S12** — The previous behavior of "/gentle:retry enable [--global]", "/gentle:retry disable [--global]", "/gentle:retry status", "/gentle:retry pause", "/gentle:retry resume", and "/gentle:retry doctor" is preserved. The only observable changes are the added auto-resume state in `status` and `doctor`, and the new command listed in the unknown-usage message.

- **S13** — The published artifact remains installable with `pi install npm:gentle-retry`, and the packed artifact keeps passing the package verifier.

- **S14** — Publishing to npm remains a separate human-authorized action and is not executed by this implementation.

## Tasks

| ID | Specs | Route | Status | Commit / Evidence |
| --- | --- | --- | --- | --- |
| T1 | S3-S8, S11-S12 | inline (parent; the delegated worker failed) | done | commit `0ac6f74`; 76/76 focused tests |
| T2 | S1-S2, S9-S10 | inline (parent) | done | 105/105 full suite, typecheck exit 0, differential check clean |
| T3 | S13-S14 | inline (parent) | done | packed artifact verified; npm publish still human-gated |

## Log

- **L1** — Verbatim: "Implementar P2 en gentle-retry"

- **L2** — Decision: P2 ("reopen and continue the interrupted turn") is implemented inside gentle-retry as an opt-in extension feature. P1 ("the work keeps running while the terminal is closed") needs a session-host daemon that owns the Pi session; Pi 1.4.0 has no daemon or socket transport, so P1 is out of scope for this repository and belongs to Pi or Gentle Shell core.

- **L3** — Verified Pi 1.4.0 facts used by the implementation: `SessionManager.getBranch(fromId?)` returns `SessionEntry[]` (`dist/core/session-manager.d.ts`); `SessionMessageEntry.message` carries an `AgentMessage`; `ExtensionAPI.sendUserMessage(content, options?)` accepts a string and returns void (`dist/core/extensions/types.d.ts`); `session_start` reasons are "startup", "resume", "new", and "fork", and the runtime emits "resume" with `previousSessionFile` when a session file is loaded (`dist/core/agent-session-runtime.js`); the assistant `StopReason` union is "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred" (pi-ai `dist/types.d.ts`).

- **L4** — Reference mechanism (read-only research, not a dependency): OpenCode keeps the session in a background server discovered through a 0600 registration file, resumes orphaned turns from a durable execution claim with the synthetic message "The server restarted while you were working. Continue from where you left off without repeating completed work.", and bounds the repeats with a durable per-turn budget (`packages/client/src/effect/service.ts`, `packages/core/src/session/execution/restart.ts` at commit `47935cae`). The budget is not reproduced here: the durable marker in S7 is the accepted anti-duplicate mechanism.

- **L5** — Routing: T1 is delegated to `gentle-ai-worker` under the context-backstop reason. The worker implements the behavior with its tests and docs in one unit and does not commit; the parent verifies, commits, and updates this document, its Engram mirror, and the visible todo list.

- **L6** — Routing incident: the delegated worker (`mw68u1sb-2-wxft`) and the explorer (`mw68lflr-1-xhi0`) both failed with "assistant reported an error (unavailable)" without touching the worktree. T1 was therefore completed inline by the parent against the same spec, and the Pi facts in L3 were verified directly against the local Pi 1.4.0 sources: `SessionManager.getBranch(fromId?)` returns `SessionEntry[]`, `SessionMessageEntry.message` carries an `AgentMessage` (`role`, `content`, `stopReason`), `ExtensionContext.mode` is the run mode, and `ExtensionAPI.sendUserMessage(content, options?)` takes a string and returns void.

- **L7** — Requirement clarification, verbatim: "The only observable change is the added auto-resume state in `status` and `doctor`." The unknown-usage message also lists the new `auto-resume` command, because every command must be named in the help text. S12 was rewritten accordingly, and the existing usage-string test was updated to pin the new text instead of leaving it unpinned.

- **L8** — Verification evidence: focused suite 76/76; full suite 105/105 (exit 0, 3m31s, including the previously stale-context suite); `tsc --noEmit -p tsconfig.json` exit 0; `node scripts/verify-package.mjs` verified the packed artifact (`gentle-retry@0.1.0`, default export function); `git diff --check` clean. Differential check against the base commit `e5de009` through a scratch driver outside the worktree: the pre-existing commands behave identically, and the only differences are the intended `auto resume: OFF` line in `status`/`doctor` and the new command in the usage message.

- **L9** — Delivery slice: the branch `feat/auto-resume` accumulates 2791 authored changed lines in 12 commits since `main` (the npm-release and retry-hardening features plus this one). The slice budget is exceeded before the next commit, so the delivery strategy is decided by the human.

- **L10** — Native assessment: `gentle_review assess` with `baseRef e5de009` and `committedOnly` returned risk `medium`, native risk `unassessable` (the untracked feature document needs an explicit declaration), native outcome `unknown`, and the plan "writer self-verification, no independent verifier". No native review was started: the medium tier defers to the slice boundary, and the candidate's own verification is complete.

- **L11** — Delivery strategy, decided by the human: `chain_strategy=feature-branch-chain`. The branch carries three stacked features — `feat/npm-release`, `feat/retry-hardening`, `feat/auto-resume` — and the delivery splits them into one chain of feature branches so each pull request stays near the review budget. The slice boundary of this feature is commit `0ac6f74`; the feature closes with this document. No push and no pull request are created by this implementation: both remain human decisions.
