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
**Fork fix:** not yet applied — logged here first
**Affected files (both upstream/main and fork):**
- `lib/msp/silent-switches.ts:36` — `extractSilentSwitches`
- `packager/src/job-processor.ts` — `extractSilentSwitches` (upstream/main line 911; the switch is re-derived at line 413 and fed to `getInstallCommand`)

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

<!-- Add further issues below in the same format. -->
