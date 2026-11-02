# gentle-retry

Unlimited retry on HTTP 429 and timeout for [Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell) and [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

## What it does

Pi already retries transient failures a few times (3 by default) with its own backoff. When that budget is exhausted, this extension keeps the agent run alive instead of stopping:

1. It reads the final failure from the assistant message.
2. If it is an **HTTP 429 / rate limit** or a **timeout**, it waits with exponential backoff (abortable with **Escape**).
3. It omits the failed assistant attempt from the model context and asks Pi for one more request with the same conversation.

**Never retries** quota errors, billing limits, authentication failures, or any non-transient error.

## Install

```bash
# From npm (when published)
pi install npm:gentle-retry

# From a local checkout
pi install /path/to/gentle-retry

# Try it for one invocation only
pi -e /path/to/gentle-retry
```

`pnpm add -g gentle-retry` **does not** register an extension with Pi. Use `pi install` or place the extension under `~/.pi/agent/extensions/`.

## Usage

After installation the extension loads automatically and starts **off**. Configure it from a Gentle Shell / Pi session:

```bash
/gentle:retry enable    # Turn on unlimited retry
/gentle:retry status    # Show current state and the config file in use
/gentle:retry disable   # Turn off (back to Pi's default retry budget)
```

Or create the config file manually:

```json
{
  "schema": "gentle-pi.retry/v1",
  "policy": "on",
  "baseDelayMs": 2000,
  "maxDelayMs": 60000
}
```

**Locations (project file wins over global):**
- Project: `<cwd>/.pi/gentle-ai/retry-policy.json`
- Global: `~/.pi/gentle-ai/retry-policy.json` (or `$GENTLE_PI_CONFIG_HOME/retry-policy.json`)

Defaults: `policy: "off"`, `baseDelayMs: 2000`, `maxDelayMs: 60000`.

## How it works

| Boundary | What happens |
|----------|--------------|
| `agent_before_settle` | Runs after Pi has exhausted its own retry budget. On a transient failure it notifies, waits with growing delay, appends a `context_edit` that omits the failed assistant entry and its tool results, and returns `continue: true`. |

Pi then issues one more provider request with the same conversation. The extension does not create a new user prompt.

## Behavior details

- **Fail closed**: missing, malformed, or unreadable config file → `off`
- **Project override**: `<cwd>/.pi/gentle-ai/retry-policy.json` wins over global
- **Delay knobs** (`baseDelayMs`, `maxDelayMs`) survive enable/disable cycles
- **Escape** interrupts the wait through Pi's run abort signal
- **No duplicate retries**: the extension only acts once Pi's native retries are done
- **Reset**: the attempt counter resets on a completed settle, an abort, or a non-transient failure

## Requirements

- `@earendil-works/pi-coding-agent` 1.4.0 or newer (the package declares the host with the `*` peer range, as Pi requires)
- Gentle Shell (bundled with Pi) or Pi Coding Agent

## Development

```bash
pnpm install
pnpm run check      # TypeScript check
pnpm test           # Builds to dist/ and runs the tests
pnpm run build      # Build to dist/
```

The tests exercise the real `agent_before_settle` event shape and Pi's real extension loader, so a passing suite means the built artifact loads and sees provider errors the same way Pi emits them.

## License

MIT
