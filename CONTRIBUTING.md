# Contributing to gentle-retry

Thanks for taking the time. This is the short version; the extension's own
behavior is documented in the [README](README.md).

## Development

```bash
pnpm install
pnpm run check            # TypeScript check
pnpm test                 # builds to dist/, then runs the suite
pnpm run build            # build to dist/
pnpm run verify:package   # verifies the packed artifact
```

The suite exercises the real `agent_before_settle` event shape and Pi's real
extension loader, so a green run means the built artifact loads and reads
provider errors the way Pi emits them.

## Pull requests

1. **Open an issue first.** It describes the problem or the proposal, and it
   gets the `status:approved` label before the work starts.
2. **Branch from `main`** with a conventional prefix: `feat/`, `fix/`, `docs/`,
   `refactor/`, `test/`, `ci/`, `chore/`, `perf/`, `build/`, or `revert/`.
3. **Commit conventionally**: `type(scope): description`, for example
   `fix(policy): fail closed on a malformed file`.
4. **Fill the pull request template.** The linked issue, exactly one `type:*`
   label, the summary, the files, and the commands you actually ran.
5. **Keep the checks green.** CI runs the typecheck, the suite, and the package
   verification on Node 22 and Node 24.

Behavior changes need a test that pins them, and a failing check is a reason to
stop, not to relax the check.

## How the work is tracked

The specifications live in `odd/tasks/`: one document per feature, with the
user's own words as the specs, the tasks, and a log of the decisions taken
along the way. The release steps are in [docs/release.md](docs/release.md), and
the user-visible changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Releasing

Releases are cut by the maintainer. The package is published to npm with the
`latest` tag, and the tag and the published version always match.
