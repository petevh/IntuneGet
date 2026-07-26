# IntuneGet — upstream issues encountered

Running log of bugs/gaps in [ugurkocde/IntuneGet](https://github.com/ugurkocde/IntuneGet)
that we hit running it self-hosted, with the fix we applied on the fork
(`petevh/IntuneGet`). Kept so we can **report these to upstream** and let the
maintainer fix them, rather than carrying divergence forever.

> Deployment context: single-user, self-hosted, local mode (SQLite catalog, no
> Supabase), single-tenant Entra app in the Kemyion tenant. Some issues may only
> manifest in this mode.

---

## 1. Stale MSAL session → infinite silent-renew loop, no login prompt

**Date:** 2026-07-20
**Severity:** High (app becomes unusable until the user manually clears site data)
**Fork fix:** `feat/web-native-detection` @ `1916a29b8` — `hooks/useMicrosoftAuth.ts`

### Symptom
After the browser session goes stale (expired refresh token/cookie — e.g.
overnight), the dashboard shows:

> **Unable to verify organization setup** — Please check your connection and try again.

The user is **never prompted to log in again**. Works fine in a fresh InPrivate
window (no stale cache). Server side is fully healthy — client-credentials token
issues correctly, has `DeviceManagementApps.ReadWrite.All`, and the Graph
`deviceAppManagement/mobileApps` test call returns 200. So the failure is
entirely client-side.

Browser console floods with:

```
Unsafe attempt to initiate navigation for frame with origin
'https://<host>' from frame with URL
'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?...'.
The frame attempting navigation of the top-level window is sandboxed, but the
flag of 'allow-top-navigation' or 'allow-top-navigation-by-user-activation' is
not set.
```

Server logs show `POST /api/auth/track-signin` with `authMethod:"silent"`
firing every few seconds in a tight loop.

### Root cause
`acquireTokenSilent` renews tokens in a **hidden, sandboxed iframe**. When the
session is stale, `login.microsoftonline.com` responds with a page that tries to
**top-navigate** to interactive login. The iframe sandbox blocks that
navigation. Critically, this failure does **not** reliably surface as an
`InteractionRequiredAuthError`.

In `hooks/useMicrosoftAuth.ts`, both `refreshToken` and `getAccessToken` only
fell back to interactive auth inside:

```ts
} catch (error) {
  if (error instanceof InteractionRequiredAuthError) {
    // acquireTokenPopup(...)
  }
  return null;   // <-- stale-iframe failures land here
}
```

Because the error wasn't that exact type, the popup fallback never fired and the
function returned `null`. `hooks/useOnboardingStatus.ts` maps a null token to
`errorType = 'network_error'` → the misleading "check your connection" banner →
the component retries → another silent iframe → infinite loop. (The popup
fallback would also have been fragile — popups are commonly blocked.)

### Fix
Fall back to `acquireTokenRedirect` on **any** silent-acquisition failure (not
just `InteractionRequiredAuthError`), in both `refreshToken` and
`getAccessToken`. A full-page redirect escapes the iframe sandbox entirely and
cannot be popup-blocked. Added a module-level `interactiveRedirectInFlight`
guard so concurrent callers don't each fire a redirect (redirect storm). The
existing `/redirect` SPA bridge handles the return leg.

### Reproduction for upstream
1. Sign in normally.
2. Let the MSAL session go stale (or revoke/expire the refresh token).
3. Reload the dashboard → loops on "Unable to verify organization setup" with the
   sandboxed-iframe console errors, and never prompts for re-login.

### Suggested upstream framing
Silent renew should degrade to an interactive **redirect** on any failure, and
the `network_error` mapping in `useOnboardingStatus` is misleading — a token
that needs interaction is not a connectivity problem. Consider surfacing
"session expired, signing you in…" instead of "check your connection."

---

## 2. Silent-switch extraction drops `KEY=VALUE` installer properties (e.g. `ACCEPT_EULA=1`)

**Date:** 2026-07-23
**Severity:** High (client install fails; wrong switches shipped to Intune, so
every device targeted by the app fails to install)
**Fork fix:** packager side **fixed** (`feat/packager-intunewin32app` @ `ff312e1e4`); web side **fixed on the interactive packaging path** (`feat/web-native-detection`), with the auto-update path logged as a separate follow-up — see **Fix status** below.
**Affected files (both upstream/main and fork):**
- `lib/msp/silent-switches.ts` — `extractSilentSwitches` (web app)
- `packager/src/job-processor.ts` — `extractSilentSwitches` (packager)

The **same broken regex is duplicated** in these two independent copies, on two
different branches, reached by two different processes. Both had to be fixed
separately.

### Symptom
Packaging **Microsoft.PowerBI** (Power BI Desktop) succeeds and uploads to
Intune, but the client-side install fails. Windows event log / MSI log:

> Product: Microsoft Power BI Desktop (x64) — EULA has not been accepted while
> executing the installation in reduced UI mode. Please add the flag
> ACCEPT_EULA=1 to the command line.

The generated install command reached the packager **with** `ACCEPT_EULA=1`, but
the switches actually handed to PSADT were only `/quiet /norestart` — the EULA
flag was silently dropped.

### Root cause
The winget manifest is correct. `Microsoft.PowerBI` 2.156.951.0 declares:

```yaml
InstallerType: burn
InstallerSwitches:
  Custom: ACCEPT_EULA=1
```

The web app normalizes this correctly: `normalizeInstaller` +
`appendCustomSwitch` (`lib/manifest-api.ts`) fold `Custom` onto the silent args,
producing `/quiet /norestart ACCEPT_EULA=1`, and `generateInstallCommand`
(`lib/detection-rules.ts`) carries it into the install command. So far correct.

The packager then **re-derives** the switches from that command string via
`extractSilentSwitches`, whose extraction regex only matches tokens that begin
with `/` or `-`:

```js
installCommand.match(/(?:\/\S+|-\S+)(?:\s+(?:\/\S+|-\S+))*/)
```

`ACCEPT_EULA=1` begins with a letter, so it is not captured. The match also
stops at the first non-`/`/`-` token, so given `/quiet /norestart ACCEPT_EULA=1`
it returns `/quiet /norestart` and discards the rest. PSADT then launches the
burn installer without `ACCEPT_EULA=1` → the EULA error above.

This is not Power BI-specific — it affects **any** app whose manifest uses
`Custom` switches (or MSI/burn properties) in `KEY=VALUE` form:
`ACCEPT_EULA=1`, `ALLUSERS=1`, `INSTALLDIR=...`, `TRANSFORMS=...`, etc.

### Secondary defect in the same regex (latent, did not affect Power BI)
When the installer filename contains hyphens, the `-\S+` alternative matches a
filename fragment. For
`"PBIDesktopSetup-2026-07_x64.exe" /quiet /norestart ACCEPT_EULA=1` the regex
returns `-2026-07_x64.exe" /quiet /norestart` — leaking part of the filename
into the argument list. (The `lib/msp` copy strips the quoted path first with
`.replace(/^"[^"]+"\s*/, '')`, so it avoids this case; the packager copy does
not pre-strip and is exposed to it.)

### Reproduction for upstream
1. Package `Microsoft.PowerBI` (Power BI Desktop) — a `burn` installer whose
   manifest declares `InstallerSwitches.Custom: ACCEPT_EULA=1`.
2. Upload to Intune and target a device.
3. Install fails: "EULA has not been accepted … add the flag ACCEPT_EULA=1".
4. Inspect the generated PSADT install step / job `silent_switches`: it contains
   only `/quiet /norestart`; `ACCEPT_EULA=1` is missing.

### Suggested upstream framing / fix
The packager should not re-parse switches out of the install-command string with
a `/`-or-`-` regex at all — it throws away every `KEY=VALUE` property. Preferred:
carry the already-normalized silent args (which correctly include `Custom`)
through to the packager as structured data instead of round-tripping through a
command string. Minimum fix: the extractor must preserve bare `KEY=VALUE` tokens
(and pre-strip the quoted installer path so hyphenated filenames don't leak).

### Fix status (fork)

The two copies were fixed with **different** strategies, because the correct
value is available at different points on each side:

**Packager — `ff312e1e4` (`feat/packager-intunewin32app`).** The packager only
ever receives the flattened `job.install_command` string, so parsing is its only
option. Rather than teach the regex about `KEY=VALUE`, the fix **stops
pattern-matching switches entirely**: strip the leading installer path (quoted,
or one bare token) and treat everything after it as switches verbatim. This also
closes the hyphenated-filename leak. Six unit tests added, including the live
`ACCEPT_EULA=1` and SSMS `--campaign <id>` cases. A second real victim was found
in the process: SSMS (`vs_SSMS.exe --quiet --wait --campaign <id>`) was failing
deterministically with exit 5005 because the campaign id (no leading `/`/`-`) was
truncated to a bare `--campaign`.

_Known residual (packager):_ the unquoted-path branch grabs a single
whitespace-delimited token, so an **unquoted** path containing spaces
(`C:\Program Files\App\setup.exe /S`) would still mis-split. Latent — install
commands are emitted with the path quoted — but not covered by a test.

**Web app — `feat/web-native-detection`.** Fixed on the **interactive
packaging path** (cart → package → upload — the path the Power BI failure was
actually on). Different strategy from the packager, because here the
correctly-normalized `silentArgs` **already exists as a structured field**
(`normalizeInstaller` → `appendCustomSwitch` in `lib/manifest-api.ts`, stored on
the installer as `silentArgs`). The web app was flattening it into
`installCommand` via `generateInstallCommand` and then re-extracting it back out
with the broken regex. Changes:

- Added `resolveSilentArgs(installer)` (exported from `lib/detection-rules.ts`) —
  the single source of truth: `installer.silentArgs || getDefaultSilentArgs(type)`.
  `generateInstallCommand` now calls it (no behaviour change).
- Added a structured `silentArgs` field to `Win32CartItem` (`types/upload.ts`),
  populated at every cart-item builder (`stores/cart-store.ts`,
  `hooks/useQuickAdd.ts`, `hooks/use-bulk-add.ts`, `hooks/use-unmanaged-apps.ts`,
  `components/PackageDetails.tsx`, `components/PackageConfig.tsx`,
  `lib/custom-app.ts`).
- `app/api/package/route.ts` now sends `item.silentArgs` verbatim (extractor kept
  only as a fallback for carts persisted before the field existed).
- `lib/msp/batch-orchestrator.ts`: the two `extractSilentSwitches('', type)` calls
  were only ever a default-switch lookup — now call `getDefaultSilentArgs(type)`.
- **Hardened the extractor itself** (`lib/msp/silent-switches.ts`) for the paths
  that still fall back to it (a user-overridden install command in
  `PackageConfig.tsx`, and legacy carts/policies): strip the leading `msiexec`
  token / installer path and the msiexec `/i|/x|/p` action + target, then take
  the remainder **verbatim** instead of the `/`-or-`-` regex. New unit test file
  `lib/msp/silent-switches.test.ts` (8 cases: `ACCEPT_EULA=1`, `--campaign <id>`,
  hyphenated filename, msiexec `/i`+`/x` property preservation, `-DeploymentType`
  fallback). Full related-suite run stayed green (128 tests).

### Follow-up: auto-update path does not resolve `Custom` switches at all (separate gap)

The **auto-update / default-config path** is _not_ fixed and is a distinct,
deeper problem — not the same drop bug. `buildDefaultDeploymentConfig`
(`lib/update-policies/build-deployment-config.ts`) constructs a
`NormalizedInstaller` **without** `silentArgs` (in local mode the catalog
`version_history` row carries no installer fields), so `generateInstallCommand`
falls through to the per-type default and the manifest's `Custom` switches
(e.g. `ACCEPT_EULA=1`) are **never present** — there is nothing for the extractor
to drop. The `packaging_jobs.silent_switches` column exists in the schema but is
never written, so it can't be used to carry the value forward either. Properly
fixing this requires resolving the manifest's `InstallerSwitches.Custom` at
config-build time (a manifest fetch in the trigger path). `app/api/updates/trigger/route.ts`
therefore still re-derives switches from `installCommand` and remains subject to
the drop for that path; a comment there points here. Deferred by choice — the
interactive path (the reported failure) is fixed; auto-update EULA apps are a
narrower case to be handled when that path gets a manifest fetch.

---

## 3. `normalizeInstallers` drops a root-level manifest `ProductCode`

**Date:** 2026-07-25
**Severity:** High (wrong detection rule shipped to Intune; app never detects as
installed, or detects against a folder that doesn't exist)
**Fork fix:** `lib/manifest-api.ts` — `normalizeInstallers`
**Affected files (both upstream/main and fork):** `lib/manifest-api.ts:507`

### Symptom
Packaging `Adobe.Acrobat.Reader.64-bit` produces a file-existence detection
rule of `%ProgramFiles%\Adobe Acrobat Reader (64-bit)` — the literal display
name used as a guessed folder name. Acrobat doesn't install to that path, so
the app never reports as installed and Intune keeps re-pushing it.

### Root cause
Winget manifests commonly declare shared installer fields once at the
manifest **root** rather than repeating them on every entry in `Installers:`
— this is standard winget-pkgs practice for anything that doesn't vary per
architecture/locale. Adobe's manifest declares `ProductCode` this way:

```yaml
PackageIdentifier: Adobe.Acrobat.Reader.64-bit
ProductCode: '{AC76BA86-1033-FF00-7760-BC15014EA700}'
Installers:
  - Architecture: x64
    InstallerType: burn
    InstallerUrl: ...
    # no per-installer ProductCode override
```

`normalizeInstallers` (`lib/manifest-api.ts`) already merges root-level
defaults down onto each installer entry for `InstallerType`, `Scope`,
`InstallerSwitches`, `UpgradeBehavior`, `Platform`, `MinimumOSVersion`, and
`Dependencies` — but not `ProductCode`:

```ts
ProductCode: installer.ProductCode as string,   // no `|| defaultProductCode`
```

So `NormalizedInstaller.productCode` ends up `undefined` for any manifest
using the root-level form, even though the manifest clearly declares one.

This was a low-impact latent bug against upstream's original marker-first
detection strategy (`productCode` was only a secondary MSI fallback, used
when `wingetId`/`version` were missing — rare). It became high-impact on this
fork's native-first detection strategy (`feat/web-native-detection`,
`generateUninstallRegistryDetectionRules`), which depends on `productCode` as
the *primary* signal for msi/wix/exe/inno/nullsoft/burn installers. Missing
it there means every such installer that uses the root-level manifest form
silently falls through to blind folder-name guessing instead of a real
uninstall-registry-key detection rule.

### Reproduction for upstream
1. Package any winget app whose manifest declares `ProductCode` at the root
   level rather than per-installer (e.g. `Adobe.Acrobat.Reader.64-bit`).
2. Inspect `NormalizedInstaller.productCode` — it's `undefined`.
3. On this fork's native-detection path: the generated detection rule is a
   folder-existence guess instead of an uninstall-registry-key rule. On
   upstream/main: any code path consulting `installer.productCode` (e.g. the
   MSI-without-marker fallback) silently gets nothing.

### Fix
Add `defaultProductCode = manifest.ProductCode as string` alongside the other
top-level defaults in `normalizeInstallers`, and merge it the same way:
`ProductCode: (installer.ProductCode as string) || defaultProductCode`.

---

## 4. Self-hosted packager never resolves the `REGISTRY_UNINSTALL:`/`MSIX_UNINSTALL:` markers

**Date:** 2026-07-25
**Severity:** High (uninstall of the app fails outright on the device)
**Fork fix:** `packager/src/job-processor.ts` — `getUninstallCommand`
**Affected files (upstream/main only — the GitHub Actions pipeline already
gets this right, the self-hosted packager is the one missing it):**
- `packager/src/job-processor.ts:1074` — `getUninstallCommand`
- Reference implementation that already works: `.github/scripts/Create-PSADTPackage.ps1:437-1271`

### Symptom
Uninstalling `Adobe.Acrobat.Reader.64-bit` (packaged via the self-hosted
packager's PSADT path) fails immediately. PSADT's own uninstall log shows
the literal command that ran:

```
Executing ["C:\Windows\System32\cmd.exe" /c REGISTRY_UNINSTALL:Adobe Acrobat Reader (64-bit)]...
Execution failed with exit code [1].
```

The webapp's package-config screen shows this same string, greyed out, as
the computed uninstall command — it's the correct default from the web
app's perspective, not a mistake there.

### Root cause
`lib/detection-rules.ts`'s `generateUninstallCommand` deliberately returns a
**marker string**, not a literal command, for any exe/inno/nullsoft/burn
installer (`REGISTRY_UNINSTALL:<displayName>`) or msix/appx installer
(`MSIX_UNINSTALL:<name>`):

```ts
// Returns a marker that tells Create-PSADTPackage.ps1 to use
// Uninstall-ADTApplication with the display name.
function generateRegistryUninstallCommand(displayName, _installerType) {
  return `REGISTRY_UNINSTALL:${displayName}`;
}
```

`.github/scripts/Create-PSADTPackage.ps1` (the original GitHub Actions
packaging pipeline) correctly detects and expands both markers into real
PSADT v4 code (`Get-ADTApplication -Name` / `Uninstall-ADTApplication -Name`,
with a `winget uninstall --id` fallback; `Get-AppxPackage` /
`Remove-AppxPackage` for MSIX). The self-hosted `packager/` is a separate,
newer reimplementation of PSADT deploy-script generation that never carried
this logic over — `getUninstallCommand` only special-cases a `psadtConfig`
override or a literal MSI GUID found in the string; everything else,
including these markers, falls through to being wrapped verbatim in
`Start-ADTProcess -FilePath cmd.exe -ArgumentList '/c <raw string>'`, so the
marker text itself gets shelled out as if it were a program name.

This is not Acrobat-specific: **every PSADT-built exe/inno/nullsoft/burn or
msix/appx app's uninstall is broken** on the self-hosted packager unless it
happens to have a `psadtConfig` uninstall override or a literal GUID
embedded in `uninstall_command`.

### Reproduction for upstream
1. Package any exe/inno/nullsoft/burn winget app through the self-hosted
   packager's PSADT path (e.g. `Adobe.Acrobat.Reader.64-bit`).
2. Trigger an uninstall from Intune.
3. PSADT's uninstall log shows `cmd.exe /c REGISTRY_UNINSTALL:<name>` failing
   with exit code 1 instead of actually removing the app.

### Fix
Port `Create-PSADTPackage.ps1`'s marker-resolution logic into
`getUninstallCommand`: detect the `REGISTRY_UNINSTALL:`/`MSIX_UNINSTALL:`
prefixes and emit the equivalent PSADT v4 / `Get-AppxPackage` code instead of
treating the marker as a literal command.

---

## 5. Deploy route hard-depends on Supabase, 500s every deploy on self-hosted sqlite

### Symptom
On a self-hosted instance running in SQLite mode (no Supabase configured),
**every** deployment fails with a generic toast "Deployment could not be
started / Internal server error." The web app itself is healthy; only
`POST /api/package` fails, and it fails identically for every app, before any
packaging work happens. Nothing appears in the server logs.

### Root cause
`app/api/package/route.ts` calls `createServerClient()` **unconditionally** to
feed MSP tenant resolution:

```ts
const { tenantId, errorResponse } = await resolveTargetTenantId({
  supabase: createServerClient(),   // <-- throws when Supabase is unconfigured
  ...
});
```

`createServerClient()` (`lib/supabase.ts`) throws `'Supabase URL and service role
key are required for server-side operations'` when the Supabase env vars are
absent. So on any self-hosted sqlite deployment the call throws on the very first
step of the handler. The exception was then swallowed by a bare `catch {}` that
returned `{ error: 'Internal server error' }` with no logging — hence the silent
500 with nothing in the logs.

MSP tenant resolution is only meaningful with Supabase (it reads
`msp_user_memberships` / `msp_managed_tenants`). A single-tenant self-hosted
instance has no MSP org and no other tenant to target, so the whole path should
be skipped — the deploy targets the token's own tenant. Note the sibling route
`app/api/updates/trigger/route.ts` already guards this exact call with
`isSupabaseConfigured()`; `/api/package` simply missed the guard.

### Introduced
Upstream commit `a483ded38` "Add MSP customer-only members (#122) and
tenant-wide duplicate detection (#127)" (2026-07-02). NOT present in the `v0.7.1`
release tag, so self-hosted instances pinned to v0.7.1 were unaffected; it only
bites once you build past that tag.

### Reproduction for upstream
1. Run the app with `DATABASE_MODE=sqlite` and no `NEXT_PUBLIC_SUPABASE_URL` /
   `SUPABASE_SERVICE_ROLE_KEY`.
2. Sign in, add any app to the cart, click Deploy.
3. `POST /api/package` returns 500 `{ error: 'Internal server error' }`.

### Fix (this fork)
Guard the MSP path with `isSupabaseConfigured()`: only call `createServerClient()`
/ `resolveTargetTenantId` when Supabase is configured, otherwise use
`tokenTenantId` directly. Also gave the swallowing `catch {}` a `console.error`
so future 500s aren't silent. Regression test added
(`app/api/package/route.test.ts`, "deploys in self-hosted mode without Supabase").

### The pattern
This is the recurring self-hosting hazard: a feature developed for the hosted
(Supabase/Vercel) topology quietly assumes that backend exists on a code path
that also runs self-hosted. Same class as the DESIGN.md §6 traps. Worth auditing
the other `createServerClient()` call sites (there are ~18) for the same
unconditional-throw pattern on request paths that must work without Supabase.

---

## 6. Native build path ignores a known ProductCode for exe installers that wrap an MSI

**Date:** 2026-07-25
**Severity:** High (uninstall silently does the wrong thing instead of removing the app)
**Fork fix:** `packager/src/job-processor.ts` — `buildNativeCommandLines` /
`getProductCodeFromDetectionRules`

### Symptom
Adobe Acrobat Reader, packaged via the native `IntuneWin32App` path (once
issue #3's fix let its detection resolve to a real uninstall-registry rule
instead of a marker), still gets a generic `Uninstall.ps1` uninstall command
instead of a direct `msiexec /x {ProductCode}`. On this specific app that
script would likely not even work: its real registry `UninstallString` is
`MsiExec.exe /I{AC76BA86-1033-FF00-7760-BC15014EA700}` (the `/I` repair verb,
not `/X` uninstall) with no `QuietUninstallString` set, and the script would
append Acrobat's *install* switches (e.g. `/sAll /msi EULA_ACCEPT=YES`) to
that `/I` command — neither the verb nor the switches are correct for an
uninstall.

### Root cause
`buildNativeCommandLines` only builds a direct `msiexec /x` uninstall when
`job.installer_type` is literally `msi`/`wix`. Winget classifies Acrobat's
installer as `exe` (it's Adobe's bootstrapper), even though the manifest
declares a real MSI `ProductCode` and native-first detection already
resolved it into `job.detection_rules`' uninstall-registry rule (issue #3).
The uninstall-command builder never looks at `job.detection_rules` at all —
it falls straight to the generic `Uninstall.ps1` fallback (registry lookup
by `DisplayName`, same technique for every non-MSI installer) whenever
`installer_type` isn't `msi`/`wix`, even when a `ProductCode` is right there
in the detection rule.

This only affects **uninstall**: install still correctly runs the exe
bootstrapper regardless (`msiexec` can't install from a bare `.exe`).

### Fix
Added `getProductCodeFromDetectionRules(job)`, which extracts the GUID from
`job.detection_rules`' uninstall-registry `keyPath` when present.
`buildNativeCommandLines` now takes a direct `msiexec /x {ProductCode}`
uninstall whenever a `ProductCode` is known this way — regardless of
`installer_type` — falling back to the generic script only when neither
`installer_type` nor detection knows one (genuine non-MSI installers like
Inno/NSIS).

---

## 7. Bare `msiexec /x` uninstallCommandLine races Intune's own post-enforcement detection re-check

**Date:** 2026-07-25
**Severity:** Medium (uninstall reported as failed in Intune even though it
actually succeeds moments later — cosmetic/reporting issue, not a real
device-state problem, but confusing and noisy)
**Fork fix:** `packager/src/job-processor.ts` — `generateNativeMsiUninstallScript`

### Symptom
Confirmed live against Adobe Acrobat Reader: after issue #6's fix, the
native `IntuneWin32App` uninstall (`msiexec /x {ProductCode} /qn /norestart`
as a bare `uninstallCommandLine`) genuinely removed the app — a direct
registry check afterward confirmed it was gone — but Intune still reported
the enforcement as `Error` (`EnforcementErrorCode: -2016345059`).

IME's own log shows exactly why:
```
EnforcementState: InProgressDownloadCompleted -> Success, EnforcementErrorCode: null -> 0   (msiexec exited 0)
Detection running for policy ...
Policy ... is expected to have enforcement state: NotDetected.
EnforcementState: Success -> Error, EnforcementErrorCode: 0 -> -2016345059                    (~150ms later)
Detection ... resulted in action status: Success and detection state: Detected.               (still sees it!)
```

### Root cause
`msiexec.exe /x ... /qn` commonly hands off the actual uninstall work to the
Windows Installer background service and its front-end process can return
before that service finishes committing the removal (registry/file
cleanup). Intune Management Extension re-runs detection within roughly
100-150ms of the enforcement process exiting — fast enough to race ahead of
that commit and see the stale "still installed" registry state, so it marks
the enforcement as failed even though the uninstall completes correctly a
moment later.

### Fix
`buildNativeCommandLines` no longer emits a bare `msiexec /x` command line
for the native build path. It now always routes MSI uninstalls (both the
`installer_type: msi/wix` case and the ProductCode-from-detection-rules case
from issue #6) through a generated `Uninstall.ps1` that runs msiexec via
`Start-Process -Wait`, then waits (up to 2 minutes) on the machine-wide
`Global\_MSIExecute` mutex — the same mutex Windows Installer itself
serializes every install/uninstall/repair operation through, and the same
technique PSADT's `Start-ADTProcess -WaitForMsiExec` uses internally — before
returning the original msiexec exit code. Control is only handed back to
Intune once Windows Installer is genuinely idle, so the post-enforcement
detection re-check no longer races ahead of the real state.

---

## 8. `extractSilentSwitches` duplicates the `msiexec /i "<path>"` prefix for MSI installers

**Date:** 2026-07-26
**Severity:** High (native-path MSI installs silently ship a malformed command line)
**Fork fix:** `packager/src/job-processor.ts` — `extractSilentSwitches`

### Symptom
Confirmed live: `Google Chrome`, packaged via the native `IntuneWin32App`
path, shipped with `InstallCommandLine`:
```
msiexec /i "googlechromestandaloneenterprise64.msi" /i "googlechromestandaloneenterprise64.msi" /qn ALLUSERS=1 /norestart
```
— `/i "<path>"` appears twice.

### Root cause
`job.install_command` for MSI packages is a **complete msiexec command
line** (e.g. `msiexec /i "file.msi" /qn ALLUSERS=1 /norestart`), not
`"<path>" <switches>` the way exe-family commands are shaped.
`extractSilentSwitches` (rewritten in issue #2's fix, 2026-07-23) only
stripped a single leading token — for this input that strips just the word
`msiexec`, leaving `/i "file.msi" /qn ALLUSERS=1 /norestart` as the returned
"switches". `buildNativeCommandLines`'s MSI branch then prepends its own
`msiexec /i "<file>"` on top of that, producing the duplicate.

The old (pre-issue-#2) regex-based extractor had a *different* bug for this
same input: it matched only the first switch-shaped token (`/i`) and
stopped at the following quoted path (which starts with `"`, not `/` or
`-`), silently discarding every real switch including `ALLUSERS=1` — quieter
than today's visible duplication, but the same underlying gap: neither
implementation accounted for MSI commands having a `msiexec /i "<path>"`
prefix instead of a bare leading path.

### Fix
Added an MSI-shaped-command branch to `extractSilentSwitches` that matches
`^msiexec(\.exe)?\s+/i\s+(?:"[^"]+"|\S+)\s*(.*)$` and returns just the
trailing switches, before falling through to the generic single-token-strip
logic used for exe-family commands. Fixes both call sites that share this
function: the native path (was producing the literal duplicate) and the
PSADT path's `extractMsiProperties` (was leaking the quoted filename token
into `-AdditionalArgumentList` for any MSI package with real properties,
since its flag-only filter never matched a stray filename token either).

---

<!-- Add further issues below in the same format. -->
