# Packager → IntuneWin32App: work-in-progress handoff

Branch: `feat/packager-intunewin32app` (fork `petevh/IntuneGet`), based on
`fix/packager-win32lobapp-create-payload`. Do packager dev **on the Windows packager
VM** — it's the only place this can actually be run and tested (needs `powershell.exe`,
the IntuneWin32App module, and a real Intune tenant). Edit + build + test + commit from
Windows; the Docker-VM clone (`/mnt/development/IntuneGet`) is only for the web-app image
and should not touch `packager/` on this branch.

## Goal (see docker-homelab `intuneget/DESIGN.md` §2/§3 for full reasoning)

Replace IntuneGet's PSADT-based packaging with the community **IntuneWin32App** module:
package the RAW installer (no PSADT wrapper). Decision already made: **upload option (a)**
— use the module for the BUILD only (`New-IntuneWin32AppPackage`), keep the existing
(fixed) TypeScript uploader `intune-uploader.ts` for the authenticated Graph upload. One
auth path; don't route the Kemyion secret through PowerShell.

## Done on this branch

- **Fixed upload payload** (`4d0792f`, inherited from the base fix branch) — five
  Graph-payload bugs in `intune-uploader.ts`. This is the PR'd fix.
- **`silent-args.ts` + tests** (`350da10`) — PSADT-independent silent-switch resolution.
  `resolveSilentArgs(installerType, wingetSilentArgs)` prefers winget's own switch, else a
  per-type default; a bare `exe`/unknown type returns `/S` flagged `guessed: true` (a wrong
  exe switch hangs an unattended install — §3). `defaultSilentArgs()` returns null for such
  types. The PSADT path's `extractSilentSwitches` now delegates to this (one source of
  truth). Verified: 10 vitest cases pass; full packager suite green.
- **Auto-install the module** (`06f0727`, `6fe561e`) — `download-tools.ps1` now installs
  the `IntuneWin32App` module if absent (idempotent; NuGet-provider + TLS-1.2 +
  trust-PSGallery bootstrapped for unattended 5.1; scope = AllUsers if elevated else
  CurrentUser). `ensureToolsAvailable` probes the module independently so the script runs
  even when IntuneWinAppUtil + PSADT already exist. Packager runs UNELEVATED → installs to
  CurrentUser, so it must be the same account the packager service runs as.

## Verified facts (don't re-derive)

- IntuneWin32App v1.5.0 needs only **PowerShell 5.0+**, no external deps → runs on the
  built-in **Windows PowerShell 5.1**. Do NOT require/spawn `pwsh` (PS7 is absent on the
  host). The packager already spawns `powershell.exe` (`runPowerShell`).
- Module auth is its own `Connect-MSIntuneGraph`. That's why upload stays option (a) — (b)
  would add a second secret-bearing auth path.

## Next steps (not started)

1. **Replace `createPsadtPackage` + `IntuneWinAppUtil.exe`** (job-processor.ts steps 3–4)
   with a `powershell.exe` spawn to `New-IntuneWin32AppPackage`. Feed the raw installer +
   the resolved silent args from `silent-args.ts`. Keep emitting the `.intunewin` +
   `encryptionInfo` the existing uploader expects (read from the package's Detection.xml,
   as the current `createIntunewinPackage` already does).
2. **Detection marker — THE real design problem (§2).** For `exe/inno/nullsoft/burn/
   portable/zip`, the web app's `lib/detection-rules.ts` emits a REGISTRY-MARKER detection
   at `HKLM\SOFTWARE\IntuneGet\Apps\{winget_id}` that only works because the PSADT script
   WRITES that marker at install. Dropping PSADT removes the writer → those apps detect
   nothing. Options: (i) re-emit the marker via a tiny post-install step (a one-line reg
   write, not full PSADT), or (ii) switch those types to folder/uninstall detection (less
   reliable — why upstream chose the marker). MSI (productCode) + MSIX (PFN script) are
   unaffected. Recommend (i).
3. **Retire PSADT provisioning** in `download-tools.ps1` (the PSAppDeployToolkit download)
   only AFTER steps 1–2 work end-to-end. Kept for now so the branch isn't broken mid-transition.
4. **Provisioning check on the VM:** run `download-tools.ps1` (or start the packager) and
   confirm `Get-Module -ListAvailable IntuneWin32App` lists 1.5.0 under the packager account.

## Build/test on Windows

```
cd IntuneGet\packager
npm install
npm run build        # tsc -> dist/
npm test             # vitest
node dist\index.js   # run the packager
```
