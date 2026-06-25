# Changelog

All notable changes to cairntrace are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [1.13.0]

### Fixed
- **`script` verifier no longer rejects numeric/boolean `fixtures` values with a misleading error.**
  `verify.script.fixtures` previously required string values (`z.record(string, string)`). Spec
  authors routinely supply numbers/booleans — most often through `${var}` interpolation (e.g. an
  expected row count of `0`, which YAML parses as a number). Because `ScriptVerifierSchema` is one
  member of the **strict** `VerifierSchema` `z.union`, a single non-string fixture value made the
  whole `script` member fail to parse, and Zod then surfaced the *sibling* members' rejection of
  the unmatched `script` key as:

  ```
  Unrecognized key(s) in object: 'script'
  ```

  i.e. a valid-looking spec read as *"the `script` verifier isn't supported."* This was easy to
  misdiagnose as a parser/schema "cold-init" defect (it appeared intermittent because it depended
  on whether a given spec's fixture values happened to be strings or numbers).

  `fixtures` now accepts `string | number | boolean` and stringifies each value, so verifiers still
  receive `Record<string, string>`. Objects/arrays are still rejected as genuine errors, and the
  `exactly one of run | file` rule is unchanged.

  - Authors no longer need to defensively quote numeric interpolations
    (`expectedRowCount: "${vars.count}"`); `expectedRowCount: ${vars.count}` works.

### Investigation note
- An earlier hypothesis blamed a TDZ / circular-import in `src/core/schema/*` causing union members
  to be dropped at construction. This was **refuted**: the schema dependency graph is an acyclic
  DAG, `VerifierSchema`/`StepSchema` build with all members, and the defect did not reproduce
  against source. The true cause was the strict-union error masking a fixture type mismatch (above).

### Tests
- Added `src/core/schema/verifier.v1.test.ts` covering string/number/boolean fixtures, object/array
  rejection, and the `run`/`file` exclusivity rule.

## [1.12.0]
- Video capture (`artifacts.capture.video`), fcheap stash integration, `investigate`/`audit`,
  codemap + TinyVault integration, doctor checks. (See release notes.)
