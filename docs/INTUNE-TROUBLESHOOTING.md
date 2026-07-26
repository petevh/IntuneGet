# Intune Management Extension (IME) client-side troubleshooting

Findings about **Microsoft's own Intune Management Extension client behavior**,
discovered through live troubleshooting on real devices. Not IntuneGet bugs —
IME is closed-source and this behavior isn't documented publicly anywhere we
could find, so it's recorded here to avoid re-discovering it.

> Log location: `C:\ProgramData\Microsoft\IntuneManagementExtension\Logs\AppWorkload.log`
> (rotates to `AppWorkload-<timestamp>.log` at some size threshold; check the
> rotated file too if you don't find what you're looking for in the active one).

---

## GRSManager: a detection/enforcement cache that can get stuck indefinitely

**Observed:** 2026-07-25/26, against a "Microsoft Store app (new)" (`winGetApp`)
deployment of Adobe Acrobat Reader.

### Symptom
An app's desired state is correctly "Required"/"Install", and the app is
genuinely absent from the device — but IME never attempts to install it.
`EnforcementState` stays `null`/`1000` (nothing pending) indefinitely, across
any number of manual syncs, even hours or days apart. The app just never gets
re-evaluated as needing action.

### What's actually happening
Every app policy evaluation logs lines like:

```
[Win32App][GRSManager] Found GRS value: 07/25/2026 11:30:45 at key
  <UserSID>\GRS\<hash>\<AppId>
[Win32App][GRSManager] App with id: <AppId> is not expired.
```

IME caches a per-app "last known good" detection/enforcement result (GRS —
exact acronym unconfirmed, behaves like a grace/cooldown state) keyed by a
`<UserSID>\GRS\<hash>\<AppId>` registry path. While that cached entry is
considered "not expired", IME appears to skip re-evaluating the app
meaningfully — it doesn't just skip a redundant detection check, it can also
skip triggering enforcement (install/uninstall) even when the actual
desired-state-vs-detected-state comparison would otherwise demand action.

We could not find a documented expiry duration. In the case we hit, the same
GRS value persisted unchanged across **12+ hours and 15+ sync cycles**
(overnight) with no sign of self-expiring.

### What did *not* fix it
- Manually triggering "Sync" repeatedly (any number of times).
- Toggling the app's assignment between Required and Uninstall — **only
  works if the assignment change actually reaches the device**. In our case
  an accidental "Excluded" assignment silently no-op'd this attempt for
  several hours before we noticed the mistake.
- Changing the assignment intent alone doesn't force a cache-bust if IME
  decides the GRS entry still isn't expired.

### What did fix it
1. Find the exact GRS key from the `AppWorkload.log` line for the affected
   app (`Found GRS value: ... at key <UserSID>\GRS\<hash>\<AppId>`).
2. In `regedit.exe` (elevated), navigate to:
   ```
   HKLM\SOFTWARE\Microsoft\IntuneManagementExtension\Win32Apps\<UserSID>\GRS\<hash>\<AppId>
   ```
   Note: `<hash>` is a single key name that can itself contain a literal `/`
   (it looks base64-encoded) — browse to it visually rather than scripting a
   `Remove-Item` path, since `/` inside a key name can trip up PowerShell's
   registry-provider path parsing.
3. Delete that `<AppId>` subkey (or the whole `<hash>` subkey if it's the
   only app under it).
4. `Restart-Service -Name IntuneManagementExtension -Force`
5. Sync. IME logged a **new** GRS value on the next real detection run,
   confirming the cache had reset — and enforcement finally proceeded
   correctly from there (detected the true absent state, installed, and the
   Store app version showed up correctly).

### Which app types this affects
Only confirmed against a `winGetApp` (Store app) deployment. Regular Win32
apps (both the PSADT and native `IntuneWin32App` paths used elsewhere in this
project) were re-evaluated correctly on every sync throughout the same
incident window — `DetectionActionHandler`/`ExecutionActionHandler` ran fresh
each time, with no equivalent "is not expired" skip observed for them. GRS
log lines *do* appear for Win32 apps too, but didn't visibly block their
detection/enforcement the way they did for this Store app. Not fully
understood why the impact differs by app type — flagging as unconfirmed
rather than asserting a firm rule.

### Practical implication
If you ever manage software that's Store-managed (`winGetApp`) alongside
custom Win32 packages for the same product, **don't remove the software via
an unrelated management channel** (e.g. uninstalling it through a different
app's uninstall command) — that desyncs the Store app's own cached state from
reality, and recovering from it needs the registry-key fix above rather than
anything self-healing. Remove/reinstall through the same channel that's
tracking it.

This is one of the concrete reasons this project defaults to Win32
(`IntuneWin32App`) packaging over the Store app route where both are viable —
see `DESIGN.md` for the broader packaging strategy — not because Store apps
misbehave in normal use, but because when something *does* go wrong, Win32
apps expose real diagnostics (actual install/uninstall commands, real process
exit codes, MSI event log entries) where Store apps are an opaque black box.

---

<!-- Add further IME client-side findings below in the same format. -->
