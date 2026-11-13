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
  - "Error: Connection error.: getaddrinfo ENOTFOUND integrate.api.nvidia.com"
  - "Warning: Context usage is at 106% (≥ 90%); consider compacting before the next turn."
  - "Error: Connection error.: getaddrinfo ENOTFOUND integrate.api.nvidia.com"
  - "Error: Request timed out.: Connect Timeout Error (attempted addresses: 99.83.136.103:443, 75.2.113.119:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT)"
  - "Error: terminated: read ETIMEDOUT"

- **S3** — Verification request, verbatim: "Luego que tengas la compatibilidad lista para todos esos errores vas a hacer prubeas controladas para asegurarte que gentle-retry funcione como debe funcionar asegurate de probar todas las funcionalidades que trae-"

- **S4** — OpenCode compatibility constraint, verbatim: "Quiero compatibilidad total con Opencode ten en cuenta que ya opencode integra la continuacion automatica de la sesion despues de reiniciar la termina."

- **S5** — Pi restart continuation request, verbatim: "Aveces se me cierra la terminal y cuando la vielvo a abrir la conversacion no continua automaticamente como deberia hacer, revisa eso y haz que cuando abra mi terminal si lo tengo configurado en el menu continuen las conversaciones en gentle-shell (pi) por donde mismo se crean, como si sucede en Opencode no se que mecanismo vas a usar si enviarle un prompt u otra cosa."

- **S6** — Retry-chat hygiene request, verbatim: "Cuando gentle-retry lleva bastante tiempo reintentando se llena la conversasion de errores como podemos mantener ej funcionamiento pero sin que los errores se muestren como parte del chat ?"

## Tasks

| ID | Specs | Route | Status | Commit / Evidence |
| --- | --- | --- | --- | --- |
| T1 | S2 | inline (parent) | done | commits `48f9b6f` + pending: DNS/timeout/context-pressure coverage green |
| T2 | S1, S4 | delegated writer, then inline fallback | done | commits `082cbcc`, `349bc33`; 15/15 OpenCode tests, 65/65 focused tests, build exit 0 |
| T3 | S1, S4 | delegated writer, then inline correction | done | commit `c5fdfb4`; 10/10 package/loader tests, packed artifact verified |
| T4 | S3 | inline parent + independent verifier | pending | pending: controlled coverage evidence |
| T5 | S1-S6 | inline (parent) | pending | pending: full verification and package evidence |
| T6 | S5 | inline (delegated worker failed) | done | commit pending: transient-error resume and incomplete-continuation recovery green |
| T7 | S6 | pending exploration | pending | pending: retry-chat hygiene evidence |

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

- **L9** — Requirement change, verbatim: "Añade compatibilidad a estos errores. Error: Connection error.: getaddrinfo ENOTFOUND integrate.api.nvidia.com Warning: Context usage is at 106% (≥ 90%); consider compacting before the next turn. Error: Connection error.: getaddrinfo ENOTFOUND integrate.api.nvidia.com Error: Request timed out.: Connect Timeout Error (attempted addresses: 99.83.136.103:443, 75.2.113.119:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT) Error: terminated: read ETIMEDOUT"

- **L10** — Requirement refinement (S2): the DNS lookup failure, connect timeout, and read timeout are transient and must be retried by both Pi and OpenCode. The 106% context-usage warning is not a transient provider failure: retrying the same oversized context cannot reduce it, so gentle-retry must leave it to Pi/OpenCode compaction instead of consuming a retry attempt. T1 is reopened for exact classifier coverage; T4 waits for that correction before the complete regression run.

- **L11** — Requirement change, verbatim: "Aveces se me cierra la terminal y cuando la vielvo a abrir la conversacion no continua automaticamente como deberia hacer, revisa eso y haz que cuando abra mi terminal si lo tengo configurado en el menu continuen las conversaciones en gentle-shell (pi) por donde mismo se crean, como si sucede en Opencode no se que mecanismo vas a usar si enviarle un prompt u otra cosa."

- **L12** — Requirement change, verbatim: "Cuando gentle-retry lleva bastante tiempo reintentando se llena la conversasion de errores como podemos mantener ej funcionamiento pero sin que los errores se muestren como parte del chat ?"

- **L13** — Scope split (S5, S6): T6 investigates and repairs Pi restart continuation in the original session, using the existing opt-in menu state. Durable continuation is at-least-once for an interrupted turn: a completed turn is never continued twice, while a saved continuation without a completed reply is retried so it cannot be stranded. T7 investigates the supported Pi extension boundary for keeping long retry sequences operational without rendering every failed provider attempt as normal chat history. The two units are independent: T6 changes continuation detection; T7 changes retry presentation only.

- **L14** — T1 evidence (S2, new failure forms): RED was observed with 9/10 classifier tests passing; the new bare DNS lookup failed because `ENOTFOUND` was not classified. GREEN followed with 10/10 passing after adding `ENOTFOUND`/`EAI_AGAIN` as connection failures and explicit `UND_ERR_CONNECT_TIMEOUT` as a timeout. The exact DNS, connect-timeout, and read-timeout forms are transient; the 106% context-usage warning remains non-transient and is left to Pi/OpenCode compaction. Risk: none — the shared classifier remains additive and existing quota, auth, generic 400, and content-safety cases are unchanged.

- **L15** — T6 evidence and host boundary (S5): RED was observed with 17/20 auto-resume tests and 60/62 combined auto-resume/extension tests passing; transient errors were not detected and persisted continuations could be stranded by the old marker. GREEN followed with 62/62 passing. The pure detector now resumes an assistant error only when the shared classifier says it is transient; permanent failures, explicit aborts, and completed turns remain untouched. A saved `AUTO_RESUME_PROMPT` with no completed reply is retried, while a completed continuation is never sent twice. Pi's public `ExtensionContext` has no `switchSession` method; session replacement is available only in user-initiated command contexts. Therefore the original conversation is reopened by Pi's supported `pi --continue`/`/resume` path, and the README/troubleshooting now state that plain `pi` creates a new session and a launcher must use `--continue` for terminal-level reopening. Risk: item 3 — the observable auto-resume contract changes from exactly-once to at-least-once only for a continuation that never completed; the prompt is stable and idempotent, and the existing opt-in remains off by default.
