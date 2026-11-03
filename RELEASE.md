# Release runbook — @phlix/syncplay

dist/ is committed on purpose: consumers install the GitHub tag
(`github:detain/phlix-syncplay#vX.Y.Z`), and npm packs exactly `files: ["dist"]`
from that checkout — no build happens on the consumer side. The tag IS the
artifact, so the ritual below is not optional.

1. **Bump** `version` in `package.json` (semver; wire-visible changes force a
   minor at minimum — SPEC.md carries the normative law).
2. **CHANGELOG fold**: rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`
   and open a fresh empty `[Unreleased]` section above it. Historical entries
   are verbatim — corrections land as NEW entries, never edits.
3. **Deterministic rebuild, twice**: `npm run build` →
   `find dist -type f | sort | xargs md5sum | md5sum` → build again → same
   aggregate. Both builds and the committed bytes must agree; if not, the
   build became non-deterministic — fix that before releasing. Record the
   aggregate md5 in the release commit message.
4. **Gates** (all green, in this order): `npm run lint`,
   `npm run typecheck`, `npm run test:run` (vitest runs serially; jest-style
   file-parallelism has bitten estate bundles before).
5. **Commit** `release: @phlix/syncplay vX.Y.Z — version bump X.(Y-1)→X.Y,
   CHANGELOG fold; committed dist byte-identical`, then
   `git tag -a vX.Y.Z -m "vX.Y.Z"`.
6. **Push + verify**: `git push origin master` and
   `git push origin refs/tags/vX.Y.Z` (plain single-refname tag push; never
   `--tags`), then `git ls-remote --tags origin | grep vX.Y.Z` to confirm the
   tag object and its peel.
7. **Consumer cascade**: ui re-pins, then mobile/tizen/windows rotate their
   contract pins per each repo's era-test law; server/hub rotate the
   `@phlix/contracts`-embedded fixtures only if error codes moved. The README
   install example in THIS repo must carry the NEW tag (tripwired in
   `test/specDocLaw.test.ts`).
