# Troubleshooting

## Commands and diagnostics

Run `/gentle:retry status` to see the effective policy, whether it came from
the project or global file, the delay bounds, optional retry limits, and
whether this session is paused.

Use `/gentle:retry pause` and `/gentle:retry resume` for temporary,
session-scoped control. They do not change the saved project or global policy.

Use `/gentle:retry doctor` when the extension is installed but does not behave
as expected. It reports configuration and installation diagnostics without
reading or printing credentials.

Run `/gentle:retry` without arguments to get the interactive menu titled
`Gentle retry (current: on)`: every action — enable and disable per project or
globally, pause and resume for this session, the auto-resume switch, the
status, and the diagnostics — in one place.

Use `/gentle:retry auto-resume on|off [--global]` to control the separate
auto-resume switch, which continues a turn that was interrupted when the
session was reopened.

## The extension is installed but nothing happens

That is the default. gentle-retry ships **off**, because an unlimited retry loop
must never switch itself on inside someone else's session.

```bash
/gentle:retry status     # shows ON or OFF and which config file won
/gentle:retry enable     # turns it on for the current project
```

If a first-run notice appeared once and you dismissed it, this is the command it
was pointing at. The notice never repeats.

## The session stopped when I closed the terminal

Pi owns the run: when the terminal closes, the process dies and the turn ends
mid-flight. Reopening the session restores the transcript, not the run.

`/gentle:retry auto-resume on` opts into continuing that interrupted turn. On
the next session start, gentle-retry detects a turn with no reply — or a reply
that was still running — and sends one continuation message.

```bash
/gentle:retry auto-resume on          # project scope
/gentle:retry auto-resume on --global # every project
/gentle:retry status                  # shows "auto resume: ON"
```

It stays quiet for turns that ended normally, that you aborted, or that failed
with a provider error: those belong to you or to the retry sequence. The same
turn is never continued twice. A turn that died after a tool already ran can
repeat that side effect, so the switch is opt-in.

What it does not do is keep the work running while the terminal stays closed.
That needs a session host that owns the run, and Pi does not provide one.

## The agent stopped when the internet went down

Without reconnect mode, a network outage ends the turn: either the error is
not one gentle-retry retries, or the retry budget runs out while the machine
still has no route to the internet.

`/gentle:retry reconnect global` makes the extension wait for the connectivity
and resume the work by itself:

```bash
/gentle:retry reconnect global   # every live Pi session
/gentle:retry reconnect session  # only the sessions that opt in
/gentle:retry reconnect enable   # opt this session in
/gentle:retry status             # shows "reconnect: global"
```

The extension checks the connectivity with one small request before it changes
anything. While the machine is online, a timeout is still just a timeout and
the retry sequence handles it exactly as before. While the machine is offline,
the turn waits (five minutes at most, Esc stops it) and then continues by
itself, either in the same run or with one continuation message.

If that is too wide for your setup, pick a narrower scope: `off` turns the
feature off for the project, `session` requires every session to opt in, and
`global` reaches every session on the machine. The scope in effect is always
shown by `/gentle:retry status` and `/gentle:retry doctor`.

## It still stops after a failure

Check the failure text. gentle-retry only acts once Pi has exhausted its own
retry budget, and only for transient causes:

- HTTP 429 or any message that reads as a rate limit or throttle.
- A timeout, a deadline, a dropped connection, or a connection error.
- HTTP 502 or Bad Gateway.
- A stream that ended without `finish_reason`.
- HTTP 400 only when the message says `DEGRADED function cannot be invoked`.

Everything else is left to Pi on purpose. In particular these are **never**
retried, because waiting does not fix them and only burns time:

- `insufficient_quota`, `quota_exceeded`, `out_of_budget`
- `billing`, `available_balance`, `credit_limit`, `spending_limit`
- `monthly_usage_limit`, `subscription_sharing`, `plan_limit`
- `payment_required`, `upgrade_required`
- Authentication and authorization failures
- Generic HTTP 400 failures that are not the named degraded-function condition

`/gentle:retry status` reporting `ON` while a run dies immediately means the
failure was classified as non-transient. That is the intended behaviour.

## The config file seems ignored

Resolution order, first match wins:

1. `<project>/.pi/gentle-ai/retry-policy.json`
2. `~/.pi/gentle-ai/retry-policy.json`, or `$GENTLE_PI_CONFIG_HOME/retry-policy.json`
3. Built-in default: `off`

A project file always beats the global one. To see which file is actually in
use, read the `source:` field in the output of `/gentle:retry status`.

## I edited the config by hand and now it is off

A file that is unreadable, malformed, or missing the expected `schema` fails
closed to `off` rather than guessing. `/gentle:retry status` reports it as
`malformed`. Rewrite it with `/gentle:retry enable`, or use this shape:

```json
{
  "schema": "gentle-pi.retry/v1",
  "policy": "on",
  "baseDelayMs": 2000,
  "maxDelayMs": 60000
}
```

Unknown extra fields also make the file malformed, by design: a typo must be
visible, not silently ignored.

## The wait is too long, or too short

`baseDelayMs` is the first wait; each attempt multiplies the exponential delay by
1.8. Jitter is up to 10% of that current delay, and the final wait is capped
at `maxDelayMs`. Defaults are 2000 and 60000, so the sequence is roughly 2s,
3.6s, 6.5s, 11s, 21s, 38s, then 60s onward.

If the provider error includes a usable `Retry-After` value, the provider value
controls the wait instead. It is capped at `maxDelayMs`; malformed or unknown
values fall back to the exponential backoff above.

```json
{ "schema": "gentle-pi.retry/v1", "policy": "on", "baseDelayMs": 1000, "maxDelayMs": 30000 }
```

Optional `maxAttempts` and `maxElapsedMs` fields cap a retry sequence. They are
unlimited when omitted. When a cap is reached, gentle-retry reports the limit
and stops retrying; use `/gentle:retry resume` to begin a fresh sequence.

Changing these does not require re-enabling; `/gentle:retry enable` preserves
them across on/off cycles.

## How do I stop a wait that is already running

Press **Escape**. The wait observes the run's abort signal and stops
immediately, and the attempt counter resets with it.

## The counter restarted

The attempt counter resets when a turn completes, when you abort, when the
failure is not transient, when the retry policy changes, and on a session
change. So the first retry after a successful turn waits the base delay again
instead of the long tail.

## After `/reload`, `/new` or `/resume` I saw no error but no retry either

A run that was still in flight when the session was replaced can no longer act:
its context is dead. gentle-retry detects that and steps aside silently instead
of failing your turn with an extension error. Start a new turn; the next failure
retries normally.

## Scripted and headless modes

`pi -p`, JSON and RPC modes never receive the first-run notice, so they cannot
pollute output you parse. Retries themselves keep working; the wait simply
happens without a notification.
