---
title: "Investigate intermittent dependency-override glob test failure"
kind: problem
status: pending
created: 2026-11-07
summary: "The first full test run failed because Jake FileList did not include package.json; the isolated test and subsequent full suite passed. Diagnose this intermittent failure so unrelated workflow work does not get misleading test failures."
---

## Why
`npm test` failed at `src/lib/dependency-overrides.test.ts:14` (`assert.ok(files.includes("package.json"))`) during a concurrent Next build. That run had 681 passes and one failure; the isolated test and a subsequent full run passed. The cause is not yet established; do not assume the Minimatch override is broken.

## What to do
Reproduce the intermittent FileList result, including a build running concurrently. Determine whether traversal of the mutable working directory affects the test, and make the test deterministic using an isolated fixture if that is the cause. Keep coverage of Jake and the other actual dependency consumers.

## Where
- `src/lib/dependency-overrides.test.ts:12-14`
- Evidence: `test-results/2026-11-07-retry-3799c8-tests.log` (local ignored log); subsequent passing run: `test-results/2026-11-07-retry-3799c8-tests-final.log`.
