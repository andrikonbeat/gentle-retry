# Troubleshooting

## The extension is installed but nothing happens

That is the default. gentle-retry ships **off**, because an unlimited retry loop
must never switch itself on inside someone else's session.

```bash
/gentle:retry status     # shows ON or OFF and which config file won
/gentle:retry enable     # turns it on for the current project
```

If a first-run notice appeared once and you dismissed it, this is the command it
was pointing at. The notice never repeats.

## It still stops after a failure

Check the failure text. gentle-retry only acts once Pi has exhausted its own
retry budget, and only for two causes:

- HTTP 429 or any message that reads as a rate limit or throttle.
- A timeout, a deadline, or a dropped connection.

Everything else is left to Pi on purpose. In particular these are **never**
retried, because waiting does not fix them and only burns time:

- `insufficient_quota`, `quota_exceeded`, `out_of_budget`
- `billing`, `available_balance`, `credit_limit`, `spending_limit`
- `monthly_usage_limit`, `subscription_sharing`, `plan_limit`
- `payment_required`, `upgrade_required`
- Authentication and authorization failures

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

`baseDelayMs` is the first wait; each attempt multiplies it by 1.8, with up to
10% jitter, until `maxDelayMs` is reached. Defaults are 2000 and 60000, so the
sequence is roughly 2s, 3.6s, 6.5s, 11s, 21s, 38s, then 60s onward.

```json
{ "schema": "gentle-pi.retry/v1", "policy": "on", "baseDelayMs": 1000, "maxDelayMs": 30000 }
```

Changing these does not require re-enabling; `/gentle:retry enable` preserves
them across on/off cycles.

## How do I stop a wait that is already running

Press **Escape**. The wait observes the run's abort signal and stops
immediately, and the attempt counter resets with it.

## The counter restarted

The attempt counter resets when a turn completes, when you abort, when the
failure is not transient, and on a session change. So the first retry after a
successful turn waits the base delay again instead of the long tail.

## After `/reload`, `/new` or `/resume` I saw no error but no retry either

A run that was still in flight when the session was replaced can no longer act:
its context is dead. gentle-retry detects that and steps aside silently instead
of failing your turn with an extension error. Start a new turn; the next failure
retries normally.

## Scripted and headless modes

`pi -p`, JSON and RPC modes never receive the first-run notice, so they cannot
pollute output you parse. Retries themselves keep working; the wait simply
happens without a notification.
