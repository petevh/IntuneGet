# Handoff: harmonize `feat/packager-intunewin32app` with `main`

**From:** Claude (Linux / web-app side), 2026-07-25
**To:** Claude Windows (packager side)
**Why you, not me:** this is your branch and your Windows-native code. I can't run
the `IntuneWin32App` PowerShell path or the packager tests on Linux, so the merge
must be verified by whoever can exercise the native build. I've done the analysis
below so you don't have to re-derive it.

## TL;DR

`main` moved forward by **7 web commits** while you were working. Your branch
**already has all 35 upstream commits** (merge-base is `046260606`, PR #201), so
this is a *small* merge, not the big upstream-drift merge. Merge `main` into your
branch, resolve one predictable conflict, verify the native build, done.

```
git checkout feat/packager-intunewin32app
git merge origin/main
```

## What's new on `main` (the 7 commits you need)

Native-first detection now keys on the real winget **ProductCode** (uninstall-
registry key) instead of the IntuneGet PSADT marker, for winget-catalog apps.
Relevant commits:

- `f503777aa` web: native-first detection (uninstall-registry over IntuneGet marker)
- `2fadb7b0a` web: merge root-level manifest ProductCode onto each installer
- `82ef4418e` web: prefer ProductCode-bearing installer node; merge root ProductCode in sync
- `bb2f16d3d` web: restore registry-marker detection for custom apps under native-first

## The ONE conflict to expect (and how to resolve it)

You have commit **`5c210a78a`** ("web: merge root-level manifest ProductCode onto
each installer"). **That exact change is already on `main`** — I cherry-picked it
there as `2fadb7b0a` (identical content, different SHA). So git will flag a
conflict in the two files both sides touched:

- `lib/manifest-api.ts`
- `lib/__tests__/manifest-api.test.ts`

**Resolution: take `main`'s version.** They are the same change. Do NOT apply it
twice. After the merge, `git log --oneline | grep ProductCode` should show the
change once, not duplicated. `UPSTREAM-ISSUES.md` exists only on your branch — keep
your version (main deliberately doesn't carry it; it's packager-side documentation).

## Detection-contract change that affects the packager

The packager CONSUMES detection rules the web app generates. Two behaviours changed
— verify the native `IntuneWin32App` path still handles them:

1. **Winget apps** now often produce a **registry-existence** rule (uninstall key,
   no version compare) or a **file/folder** rule — not always the IntuneGet marker.
2. **Custom apps** (installer-URL apps, `lib/custom-app.ts`) still produce the
   **IntuneGet marker** rule (version-compared). `bb2f16d3d` restored this — under
   native-first they had regressed to a bogus folder guess. Confirm the packager's
   marker-writing (PSADT) still runs for custom apps and the rule matches.

The rule shapes are unchanged types (`RegistryDetectionRule` / `FileDetectionRule`
with `detectionType: 'exists' | 'version'`) — but the *mix* of which apps get which
rule changed. If the native path assumed "always marker," that assumption is gone.

## Verify before merging to main

- `npm test` (web suite is 510 green on main as of `bb2f16d3d`).
- **Packager tests on Windows** — `packager/tests/*` — which I could not run.
- Exercise the `IntuneWin32App` native build against a winget app WITH a ProductCode
  (e.g. Adobe.Acrobat.Reader.64-bit) and a custom installer-URL app, and confirm the
  detection rule Intune receives matches what's installed.

## Environment note

Node 20 is required (`engines: >=20`); the repo's system node may be 18. On the
Linux box it's provided via user-local nvm. On Windows, use whatever gives you
Node >=20 for the web suite; the packager itself is PowerShell + its own Node deps.

## After you've harmonized

Once merged and verified, fast-forward `main` to your branch tip (main only ever
advances to tested code), then push. Remote hygiene is already set: `upstream` is
fetch-only (push DISABLED), `main` tracks `origin/main`.
