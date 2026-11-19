# Automatic resume and reconnect

Both features are **opt-in** because recovering a turn can repeat a side effect
that already ran. gentle-retry never resumes a completed turn or a permanent
provider failure.

## Automatic resume after reopening a terminal

With auto-resume enabled, the package-owned launcher adds `--continue` only for
an otherwise ordinary interactive launch. Pi reopens the latest session, then
gentle-retry checks whether the last turn can be resumed.

The launcher delegates to the real Gentle Shell or Pi executable. Explicit
arguments and noninteractive invocations are forwarded unchanged. Use
`command gentle-shell` or `command pi` to bypass it.

Without the launcher, use `pi --continue` or `/resume`: plain `pi` creates a new
session. The extension alone cannot replace a session from `session_start`
because Pi exposes session replacement only to user-initiated commands.

### What is resumed

- A user turn with no assistant reply.
- A reply that was still pending or using tools when the process died.
- A transient provider failure covered by the shared classifier.
- A saved continuation that never completed.

### What is not resumed

- A normally completed turn.
- An explicit abort.
- Authentication, quota, billing, generic HTTP 400, or other permanent failures.
- A continuation that already completed successfully.

Recovery is **at-least-once**: an unfinished saved continuation is retried with
the same idempotent prompt, while a completed continuation is never sent twice.

## Reconnect after an outage

Reconnect handles live sessions whose machine has lost connectivity:

```text
/gentle:retry reconnect global   # every live Pi session
/gentle:retry reconnect session  # only sessions that opt in
/gentle:retry reconnect enable   # opt this session in (scope "session")
/gentle:retry reconnect disable  # opt this session out
/gentle:retry reconnect off      # turn reconnect off for this project
```

The global scope is written to the global policy. Session and off scopes are
written to the project policy, which retains precedence.

### Behavior

- Two consecutive failed probes are required before the machine is considered
  offline, so the check may cost two small requests.
- While offline, the turn waits up to five minutes without consuming a retry
  attempt. Escape stops the wait.
- If that wait expires, the turn ends and the session watches in the background
  for up to one hour. Disable reconnect to stop the watch.
- When connectivity returns, work continues without the failed message in model
  context. If the turn already ended, one continuation message starts a new run.
- One outage resumes at most three times, and a turn is never resumed twice.
- Billing, authentication, and permanent bad-request failures never wait.

Reconnect covers sessions that are still alive. Auto-resume handles a session
whose process died and is reopened later.

## Retry presentation and host boundary

Retry progress uses a transient footer status and clears when the turn
completes. Compact `gentle-retry-retry` diagnostic entries contain only attempt,
failure kind, and delay; they stay outside LLM context and have no chat renderer.

Pi owns rendering of failed assistant messages. Its extension API has no
supported hide/delete operation, so provider-owned errors can still appear in
the transcript even though they are omitted from model context. Fully hiding
those lines requires a Pi host feature such as a non-displayed assistant-message
flag or a TUI filter. gentle-retry does not falsify transcript messages.

## Related guides

- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
