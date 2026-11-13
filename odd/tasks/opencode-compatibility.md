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
| T1 | S2 | inline (parent) | done | commit pending: RED 8/10, GREEN 10/10, build exit 0 |
| T2 | S1, S4 | pending architecture decision | pending | pending: OpenCode adapter evidence |
| T3 | S1, S4 | pending architecture decision | pending | pending: package/install/control evidence |
| T4 | S3 | pending architecture decision | pending | pending: controlled coverage evidence |
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

- **L4** — T1 evidence (S2): RED was observed first with 8/10 focused tests passing and the two new direct/wrapped content-safety 503 cases failing as expected. GREEN followed with 10/10 focused tests passing; `pnpm run build` exited 0 after 4m35s. The shared classifier now reports the new additive `content_safety_screening` kind for the exact temporary-screening wording. Risk: none — the shared classifier change is additive and leaves quota, authentication, generic HTTP 400, and other existing classifications unchanged.
