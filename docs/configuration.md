# Configuration reference

gentle-retry is **off by default**. Retry, auto-resume, and reconnect are
independent opt-in features. Project configuration overrides global
configuration, and malformed or unreadable configuration fails closed.

## Policy locations

| Scope | Path |
| --- | --- |
| Project | `<project>/.pi/gentle-ai/retry-policy.json` |
| Global | `~/.pi/gentle-ai/retry-policy.json` |
| Global override | `$GENTLE_PI_CONFIG_HOME/retry-policy.json` |

Pi and OpenCode 2 read the same project policy. OpenCode also accepts strict
plugin options through `opencode.json`.

A valid project file takes precedence even when a global policy is enabled. A
malformed project file does not fall back to global configuration: it disables
the affected behavior instead of guessing.

## Fields

```json
{
  "schema": "gentle-pi.retry/v1",
  "policy": "on",
  "baseDelayMs": 2000,
  "maxDelayMs": 60000,
  "maxAttempts": 20,
  "maxElapsedMs": 900000,
  "autoResume": false,
  "reconnect": "off"
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `schema` | required | Must be `gentle-pi.retry/v1`. Unknown schemas are rejected. |
| `policy` | `"off"` | `"on"` or `"off"`. Controls transient retries. |
| `baseDelayMs` | `2000` | First wait in milliseconds; must be a positive integer. |
| `maxDelayMs` | `60000` | Maximum wait in milliseconds; must be at least `baseDelayMs`. |
| `maxAttempts` | unlimited | Optional positive-integer cap on one retry sequence. |
| `maxElapsedMs` | unlimited | Optional positive-integer time cap for one retry sequence. |
| `autoResume` | `false` | Continue a resumable interrupted or transiently failed turn. |
| `reconnect` | `"off"` | `"off"`, `"session"`, or `"global"`. |

Unknown fields, invalid values, inverted delay bounds, and malformed JSON make
the policy invalid. Delay and limit fields survive enable/disable cycles.

## Backoff and provider guidance

Each attempt multiplies the exponential delay by **1.8**. Jitter is up to **10%**
of the current delay, and the final wait is capped by `maxDelayMs`. With the
defaults, the approximate sequence is 2s, 3.6s, 6.5s, 11s, 21s, 38s, then 60s.

A valid `Retry-After` delta-seconds or HTTP-date value controls the next wait
instead of exponential backoff. It remains capped by `maxDelayMs`; malformed or
unknown values use normal backoff. Press **Escape** to cancel a wait.

## OpenCode 2 plugin options

OpenCode V2 uses the `plugins` array with a package and an options object:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "gentle-retry",
      "options": {
        "policy": "on",
        "baseDelayMs": 2000,
        "maxDelayMs": 60000,
        "maxAttempts": 20,
        "maxElapsedMs": 900000
      }
    }
  ]
}
```

Accepted options are `policy`, `baseDelayMs`, `maxDelayMs`, `maxAttempts`, and
`maxElapsedMs`. Unknown options or invalid values fail closed to `off`. Valid
options override individual fields from the shared project policy. Limits are
enforced independently per OpenCode session.

OpenCode's native restart continuation and hard retry ceiling remain
authoritative. The plugin changes retry decisions only; it never starts a
session, synthesizes messages, or sends a continuation prompt.

## Related guides

- [Auto-resume and reconnect](auto-resume.md)
- [Troubleshooting](troubleshooting.md)
