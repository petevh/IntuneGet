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
   the resolved silent args from `silent-args.ts`. **Install command:** use the user's
   `psadtConfig.installCommand`/`uninstallCommand` override when set (the ONE PSADT feature
   kept — see scope table), else build from installer + silent args. Keep emitting the
   `.intunewin` + `encryptionInfo` the existing uploader expects (read from the package's
   Detection.xml, as the current `createIntunewinPackage` already does). **Delete** the
   dropped-feature code paths as PSADT goes: post-install/uninstall commands,
   removeExistingInstall, verifyInstall, zip nested-installer.
2. **Detection — prefer NATIVE, marker only as last resort (CORRECTED — the marker
   affects EVERY app, not just non-MSI).** `lib/detection-rules.ts::generateMsiDetectionRules`
   (and the other branches) `return` the registry-marker rule whenever `wingetId+version`
   are present — i.e. always — so the productCode/folder branches are DEAD CODE at runtime.
   The marker (`HKLM\SOFTWARE\IntuneGet\Apps\{id}\Version`) is written ONLY by PSADT, so
   dropping PSADT breaks detection for ALL apps. (The earlier "MSI unaffected" note here was
   wrong — thanks to the Windows-side review that caught it.)
   **Decision (Pete):** don't re-emit the marker — stop depending on it. The marker only
   detects apps *IntuneGet* installed; native detection also captures out-of-band installs
   (IT/user/older packages), which is the real goal. Verified: winget manifests carry a
   native signal for almost everything — `ProductCode` is present even on nullsoft/inno EXE
   (it's the uninstall DisplayName, e.g. `Notepad++`), a GUID on MSI/WiX, `PackageFamilyName`
   on MSIX. Implement the tiered hierarchy (full table in DESIGN.md §2):
     - MSI/WiX → MSI product-code detection
     - MSIX/AppX → PackageFamilyName script detection
     - exe/inno/nullsoft WITH a manifest ProductCode → uninstall-registry (DisplayName/Version)
     - zip/portable/exe with NO ProductCode → PSADT + marker (the marker's legitimate tail)
   **CROSS-HOST:** tiers for native detection require editing `lib/detection-rules.ts` to
   prefer native over the marker (flip the current marker-first order). That file is in the
   WEB APP (outside `packager/`), so this change also affects the running container on the
   Docker VM — coordinate it; it's not a packager-only edit. It benefits every deployment,
   not just the new path.
3. **PSADT is KEPT (not retired) as the Tier-5 fallback** for zip/portable/markerless-exe.
   Leave `download-tools.ps1`'s PSAppDeployToolkit download in place. PSADT just stops being
   the *default* path — the packager picks IntuneWin32App vs PSADT per the hierarchy.
4. **Provisioning check on the VM:** run `download-tools.ps1` (or start the packager) and
   confirm `Get-Module -ListAvailable IntuneWin32App` lists 1.5.0 under the packager account.

## Scope: PSADT feature surface — what to keep vs. drop (decided 2026-07-19)

Windows Claude correctly flagged that today's PSADT wrapper does more than install: it
supports user-configurable behavior via `package_config.psadtConfig` (all exposed as
per-app toggles in `components/CartItemConfig.tsx` / `PackageConfig.tsx`, all default
off/empty). IntuneWin32App deliberately has no PSADT scripting surface — that simplicity
is *why* it was chosen for a single admin (DESIGN.md §1/§2). So most of these go away **by
design**, not by oversight. Pete's decision on what he actually uses:

| PSADT feature (`psadtConfig`) | Disposition on this branch |
|---|---|
| `installCommand` / `uninstallCommand` overrides | **KEEP.** IntuneWin32App takes these natively — `-InstallCommandLine` / `-UninstallCommandLine` on `Add-IntuneWin32App` (or the app object). Pass the user's override when set, else the default from the installer + `silent-args.ts`. This is the module's normal input; cheap to preserve. |
| `removeExistingInstall` | **DROP.** PSADT pre-install removal. Not used. |
| `verifyInstall` | **DROP.** PSADT post-install verification. Not used. |
| `postInstallCommands` / `postUninstallCommands` | **DROP.** Arbitrary PSADT scripting. Not used. |
| zip `nestedInstallerType` / `nestedInstallerPath` | **DROP.** Not used. NOTE: this means `.zip`-delivered apps are out of scope for the new path — if a zip app is ever needed, revisit. |
| `registryMarkerPath` | **N/A directly** — but see the detection-marker problem below; if you re-emit the marker (option i), honor a custom path when set, else the IntuneGet default. |

Net: the rewrite only has to carry the **install/uninstall command override**. Everything
else is intentionally dropped. Do not rebuild the `getCommandOverride` / post-command /
removeExisting / verifyInstall / zip-nested machinery — delete those code paths as PSADT goes.

## Stranded reasoning (DESIGN.md §2, copied here since it lives on the Docker VM)

**Why IntuneWin32App at all:** it packages the RAW installer and lets you set the install
command yourself — no PSADT wrapper. IntuneGet instead wraps every package in PSADT and
hardcodes `Invoke-AppDeployToolkit.exe`. For a single admin who doesn't need PSADT's
deferrals / user-close / rich logging, the raw path is simpler and drops the custom
pipeline entirely.

**The pipeline seam** (informs the build/upload split you're keeping): building the
`.intunewin` needs Windows; uploading it needs the Kemyion secret. They don't co-locate.
**Handoff contract from build → upload = the `.intunewin` PLUS its extracted
`encryptionInfo`** (AES key + MAC, read from the package's internal Detection.xml at build
time — Graph needs it to decrypt server-side). The existing `createIntunewinPackage`
already extracts this; preserve that output shape so the (kept) TS uploader is unchanged.

## Build/test on Windows

```
cd IntuneGet\packager
npm install
npm run build        # tsc -> dist/
npm test             # vitest
node dist\index.js   # run the packager
```
