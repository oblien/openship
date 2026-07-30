<!--
Thanks for contributing to Openship! Please skim CONTRIBUTING.md before opening this PR.
Fill in the sections below and delete any that genuinely don't apply.
-->

## Summary

<!-- What does this PR do, in one or two sentences? -->

## Motivation

<!-- What was broken, or what did the linked issue agree on? Why is this change needed? -->

## Related issue

<!--
New features, behavior changes, new dependencies, new endpoints, and schema/migration changes
need a maintainer to agree on scope *and* approach in an issue **before** the code is written —
link that issue here (for example: Closes #123).

Bug fixes, tests, docs, and small self-contained improvements don't need one. Write "None".
-->

## Changes

<!-- Bullet what changed, grouped by workspace (apps/api, apps/dashboard, packages/db, ...). -->

## Verification

<!--
How you actually verified this: the commands you ran and the before/after behavior.
Paste real output rather than describing what should happen.
-->

```bash

```

## Screenshots

<!-- Before/after for dashboard, web, or desktop changes. Delete this section if not applicable. -->

## Checklist

- [ ] One change per PR — one bug, or one agreed feature, with nothing unrelated bundled in
- [ ] The diff is scoped — no reformatting or lint fixes on lines I wasn't otherwise changing
- [ ] A test fails without this change and passes with it (or I explained above why there isn't one)
- [ ] `bun run test`, `bun run --cwd <workspace> lint`, and `bun format` all pass locally
- [ ] I understand every line of this diff and can explain it in review
