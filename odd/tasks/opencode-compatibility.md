# gentle-retry — OpenCode compatibility and content-safety retry coverage

Objective: add OpenCode compatibility to gentle-retry, cover the reported content-safety screening failures, and run controlled verification across the product's existing functionality.
Branch: `feat/opencode-compatibility`; delivery: ordered work-unit commits on the feature branch; test runner: `node --experimental-strip-types --test tests/*.test.ts` plus `tsc --noEmit -p tsconfig.json` and controlled OpenCode plugin checks.

## Specs

- **S1** — Original request, verbatim: "Quiero compatibilidad total con Opencode ten en cuenta que ya opencode integra la continuacion automatica de la sesion despues de
 reiniciar la termina.Quiero añadir compatibilidad total a este error tambien. Error: 503: {"message":"content safety screening is
 temporarily unavailable"} Error: 503: {"message":"content safety screening is temporarily unavailable"} Error: 503: {"message":"content
 safety screening is temporarily unavailable"} Error: Retry failed after 3 attempts: 503: {"message":"content safety screening is
 temporarily unavailable"}

 Luego que tengas la compatibilidad lista para todos esos errores vas a hacer prubeas controladas para asegurarte que gentle-retry funcione
 como debe funcionar asegurate de probar todas las funcionalidades que trae-"

- **S2** — Exact failures to cover, verbatim:
  - "Error: 503: {"message":"content safety screening is temporarily unavailable"}"
  - "Error: 503: {"message":"content safety screening is temporarily unavailable"}"
  - "Error: 503: {"message":"content safety screening is temporarily unavailable"}"
  - "Error: Retry failed after 3 attempts: 503: {"message":"content safety screening is temporarily unavailable"}"

- **S3** — Verification request, verbatim: "Luego que tengas la compatibilidad lista para todos esos errores vas a hacer prubeas controladas para asegurarte que gentle-retry funcione como debe funcionar asegurate de probar todas las funcionalidades que trae-"

- **S4** — OpenCode compatibility constraint, verbatim: "Quiero compatibilidad total con Opencode ten en cuenta que ya opencode integra la continuacion automatica de la sesion despues de reiniciar la termina."

## Tasks

| ID | Specs | Route | Status | Commit / Evidence |
| --- | --- | --- | --- | --- |
| T1 | S2 | inline (parent) | done | commit `48f9b6f`; RED 8/10, GREEN 10/10, build exit 0 |
| T2 | S1, S4 | delegated writer, then inline fallback | done | commits `082cbcc`, `349bc33`; 15/15 OpenCode tests, 65/65 focused tests, build exit 0 |
| T3 | S1, S4 | delegated writer, then inline correction | done | commit pending: 10/10 package/loader tests, packed artifact verified |
| T4 | S3 | inline parent + independent verifier | in_progress | pending: controlled coverage evidence |
| T5 | S1-S4 | inline (parent) | pending | pending: full verification and package evidence |

## Log

- **L1** — Verbatim: "Quiero compatibilidad total con Opencode ten en cuenta que ya opencode integra la continuacion automatica de la sesion despues de
 reiniciar la termina.Quiero añadir compatibilidad total a este error tambien. Error: 503: {"message":"content safety screening is
 temporarily unavailable"} Error: 503: {"message":"content safety screening is temporarily unavailable"} Error: 503: {"message":"content
 safety screening is temporarily unavailable"} Error: Retry failed after 3 attempts: 503: {"message":"content safety screening is
 temporarily unavailable"}

 Luego que tengas la compatibilidad lista para todos esos errores vas a hacer prubeas controladas para asegurarte que gentle-retry funcione
 como debe funcionar asegurate de probar todas las funcionalidades que trae-"

- **L2** — Compatibility research: the installed OpenCode CLI is v2.2.6. OpenCode V2 exposes the server-side `session.retry` hook; its retry event exposes the provider error (`type`, `message`, optional `status`, response body, and `retryAfterMs`) and allows a plugin to replace the retry decision and delay. OpenCode already owns restart continuation, so the adapter must not create a competing continuation path.

- **L3** — Scope interpretation: the exact content-safety screening 503 and its wrapped retry form are transient; unrelated permanent failures keep their existing classification. Existing Pi behavior remains intact while the same package gains an OpenCode V2 plugin entrypoint.

- **L4** — T1 evidence (S2): RED was observed first with 8/10 focused tests passing and the two new direct/wrapped content-safety 503 cases failing as expected. GREEN followed with 10/10 focused tests passing; `pnpm run build` exited 0 after 4m35s. The shared classifier now reports the new additive `content_safety_screening` kind for the exact temporary-screening wording. Risk: none — the shared classifier change is additive and leaves quota, authentication, generic HTTP 400, and other existing classifications unchanged. Commit `48f9b6f` (`fix: retry temporary content safety screening failures`).

- **L5** — Architecture (S1, S4): the read-only explorer mapped the current Pi-only architecture and confirmed that the shared classifier, policy, backoff, connectivity, and resume primitives can be reused without copying the Pi adapter. The OpenCode V2 adapter is a separate server plugin that registers the public `session.retry` hook, normalizes OpenCode's structured provider error, and keeps per-session retry state. It does not prompt, synthesize messages, restart sessions, or otherwise compete with OpenCode's native restart continuation. The adapter work unit is delegated because the parent is at its context backstop; its edit surfaces are disjoint from packaging and documentation.

- **L6** — Packaging direction (S1, S4): keep the existing package root as the Pi extension API and expose the OpenCode V2 server plugin through the package's `./server` export. A controlled OpenCode v2.2.6 probe confirmed that a local plugin directory with both exports loads `./server`: `opencode run --standalone --model probe/nonexistent` logged the `server.js` entrypoint and ran setup without a provider request. T3 must repeat that proof against the packed artifact while `pi install npm:gentle-retry` continues to load `dist/extension.js`.

- **L7** — T2 evidence (S1, S2, S4): the delegated writer hit a provider rate limit before writing files, and its resumed run was interrupted with the parent process, so no partial source was retained. The parent completed the same bounded unit inline. RED was observed first: both focused files failed because the OpenCode modules did not exist. GREEN followed with 15/15 OpenCode tests and 65/65 classification, Pi retry-extension, and OpenCode tests passing; `pnpm run build` exited 0 after 10m30s. The shared core is commit `082cbcc` (`feat: add shared OpenCode retry decisions`); the plugin adapter is commit `349bc33` (`feat: add OpenCode retry plugin adapter`). The plugin only mutates `session.retry` decisions and observes successful/interrupted completion events; it never prompts, synthesizes messages, or restarts a session. Risk: item 3 — the backoff helper moved into a shared module used by both adapters, but the existing Pi backoff test remained unchanged and green.

- **L8** — T3 evidence (S1, S4): the packaging worker was interrupted after writing its bounded diff and returned no result transcript, so the parent reviewed and corrected the diff instead of assuming its report. The worker had used OpenCode V1's nested `plugin` tuple syntax; the parent replaced it with the current V2 `plugins: [{ package, options }]` form in the README, troubleshooting guide, and real-loader test. The controlled real-loader test passed against OpenCode v2.2.6 and selected `dist/opencode.js`; 10/10 focused package and loader tests passed. `pnpm run verify:package` verified the real packed artifact with a function-shaped Pi root export and the object-shaped `gentle-retry` OpenCode server export. Risk: item 3 — the package gains an explicit `./server` export while the root Pi export and `pi.extensions` metadata remain unchanged; both entrypoints are asserted from the packed artifact.
