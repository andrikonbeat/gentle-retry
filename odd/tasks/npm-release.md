# gentle-retry — public npm product

Turn a working extension with no wrapper into a product a stranger can install and use.

## Specs

- **S1** — Original request, verbatim: "Vamos a comvertir esto en un producto usable por los usuarios."
- **S2** — Destination chosen by the user, label verbatim: "Publicarlo en npm". Agreed scope, verbatim: "Producto público real: inicializo git, completo los metadatos, agrego CI y proceso de release, y dejo todo listo para `pi install npm:gentle-retry`. Necesito que vos hagas `npm login` y me confirmes el nombre del paquete antes de publicar."
- **S3** — The install command for a third party is exactly `pi install npm:gentle-retry` and must work with no undocumented steps.
- **S4** — `package.json` declares, with no empty values: `author`, `repository`, `homepage`, `bugs`, `engines`, `license`, `files`, `publishConfig`.
- **S5** — Installing without configuring must not be silent: the user learns the extension exists and how to turn it on at first run, with no noise afterwards. The safety default stays `policy: "off"`.
- **S6** — No version is published unless `pnpm run check` and `pnpm test` passed in CI, and unless `CHANGELOG.md` describes that version.
- **S7** — A user hitting a failure finds the known behaviours documented: malformed config → off, quota/billing → never retries, Escape → stops the wait.
- **S8** — `npm publish` is never executed without the human's `npm login` and their explicit confirmation of the name `gentle-retry`.

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1, S4 | inline | 97061f4 |
| T2 | S4 | inline | 82f8e8d |
| T3 | S5 | inline | ea9ecf8 |
| T4 | S6 | inline | 522516b |
| T5 | S6, S8 | inline | 5d766ac |
| T6 | S7 | inline | 5d766ac |
| T7 | S3, S5 | inline | 858c64e |
| T8 | S1 | inline | — |

## Delivery slice

The first slice closes at commit `858c64e`: 5 commits, 668 authored changed lines
on `feat/npm-release` since `main`. That is past the ~400-line review slice, so
T8 adds no source lines and the review candidate for this feature is one PR over
`main..feat/npm-release`, not a further stack. Pushing, opening the pull request
and merging stay with the user.

## Log

- **L1** — Verbatim: "Vamos a comvertir esto en un producto usable por los usuarios."
- **L2** — Verbatim: "Publicarlo en npm"
- **L3** — Diagnosis on disk: `git` reports no repository anywhere in the mount; `npm view gentle-retry` returns 404; `npm whoami` returns `ENEEDAUTH`; `package.json` has `author: ""` and no `repository`/`homepage`/`bugs`/`engines`; `policy` defaults to `"off"` so a fresh install does nothing visible; there is no CI and no `CHANGELOG.md`; `docs/` holds only `skill-registry.md`.
- **L4** — Orchestrator decision, revocable by the user: keep `policy: "off"` as the default and solve the silence with first-run discovery instead of turning unlimited retry on by default. Rationale: an unlimited retry loop must never be a surprise on someone else's machine, and a wrong default here is indistinguishable from a hang.
- **L5** — Incident: three files (`CHANGELOG.md`, `docs/release.md`, `src/retry-onboarding.ts`) were written into a stray tree `1-\ Active/` because a space in the path was escaped with a backslash. The real project root is `1- Active/` (no space before the dash). Files moved back, stray tree removed, no project data lost. Lesson: pass paths literally, never shell-escaped.
- **L6** — Explorer evidence that shaped T3: Pi 1.4.0 has no load-time event (the factory body is load), the first per-session event is `session_start` fired on every startup/reload/new/resume, `ui.notify` accepts `"info" | "warning" | "error"`, `registerCommand` accepts only `description`, `getArgumentCompletions` and `handler`, and Pi exposes no per-install state store — the marker file is ours.
- **L7** — T7 found a deliverable defect: the tarball shipped neither `CHANGELOG.md` nor `docs/`, so every relative link in the published README would 404 on the registry page. Fixed by extending `files` and verified by extracting the tarball and resolving each relative link inside it (3/3 ok).
- **L8** — Verification: `pnpm run check` clean; `pnpm test` 41/41 pass (30 pre-existing, 8 onboarding unit, 3 session-start integration); packed artifact exposes `default: function` and `createGentleRetryExtension: function`.
- **L9** — Publication: `gentle-retry@0.1.0` is live on npm, published 2026-11-09T10:30:33Z with the `latest` dist-tag; `npm view gentle-retry version` returns `0.1.0` and `dist.unpackedSize` is 180680 bytes — the same value as the verified dry-run tarball, so the published artifact is the one that was checked. The published package carries the whole chain of features (retry hardening, the interactive menu, opt-in auto-resume, and opt-in reconnect mode).
- **L10** — Authentication incident: the `~/.npmrc` carried a legacy 40-character token that the registry rejected with 401, and the earlier attempt reported `EOTP` because the OTP prompt cannot be answered from a shell without a TTY. The human completed `npm login` in their own terminal, and the publish then went through with the one-time password typed at the prompt. The `prepublishOnly` hook runs the typecheck and the full suite before packing, so the publish takes several minutes and looks stalled while it runs.
- **L11** — Installation: `pi install npm:gentle-retry` succeeded and the package lives under `/home/andrik/.pi/agent/npm/node_modules/gentle-retry`. The temporary local build path was removed from `/home/andrik/.pi/agent/settings.json`, whose `extensions` array is now only `["-builtin:codemode"]` while `packages` carries `npm:gentle-retry` — the package and the local build register the same `/gentle:retry` command and cannot coexist. The remaining step of the topology decision is the retirement of the duplicated built-in copy in the `gentle-shell` repository, tracked there in `odd/tasks/retire-builtin-retry.md`.
