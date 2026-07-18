/**
 * Silent-install argument resolution — PSADT-independent.
 *
 * The IntuneWin32App path packages the RAW installer and sets the install command
 * itself (no PSADT wrapper), so it needs to know the silent switch for a given
 * installer. winget carries native `silent_args` only SOMETIMES; when it doesn't,
 * we fall back to a per-installer-type default.
 *
 * This lives apart from job-processor's `extractSilentSwitches` (which is entangled
 * with PSADT command construction — Start-ADTProcess etc.) so the new build path can
 * reuse the *knowledge* without the PSADT machinery. job-processor should delegate to
 * `defaultSilentArgs` here rather than keep its own copy of the table.
 *
 * DESIGN.md §3 caveat, enforced here: a bare `exe` has NO safe universal silent switch
 * — `/S` is only a common guess (NSIS-style) and a wrong one HANGS an unattended
 * installer on a dialog. So `resolveSilentArgs` returns a `guessed` flag for that case;
 * callers should surface it (log a warning, or require per-app confirmation).
 */

/** Installer types winget emits, mapped to their known-good silent switch. */
const DEFAULT_SILENT_ARGS: Record<string, string> = {
  msi: '/qn /norestart',
  wix: '/qn /norestart',   // wix installs an MSI under the hood
  inno: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART',
  nullsoft: '/S',
  burn: '/q /norestart',
  msix: '',                // MSIX/AppX install silently by nature — no switch
  appx: '',
};

/**
 * Installer types whose default switch is RELIABLE (the silent flag is defined by the
 * installer framework, not guessed). Bare `exe` is deliberately excluded.
 */
const RELIABLE_TYPES = new Set(Object.keys(DEFAULT_SILENT_ARGS));

export interface SilentArgsResult {
  /** The switch string to pass to the installer (may be empty for msix). */
  args: string;
  /** True when `args` is a best-effort guess that could hang an unattended install. */
  guessed: boolean;
  /** Where the value came from, for logging. */
  source: 'winget' | 'default' | 'guess';
}

/**
 * The type→switch default only (no winget input). Returns null for types with no
 * known-good default (bare `exe`), so callers must decide what to do.
 */
export function defaultSilentArgs(installerType: string): string | null {
  const t = (installerType || '').toLowerCase();
  if (t in DEFAULT_SILENT_ARGS) return DEFAULT_SILENT_ARGS[t];
  return null;
}

/**
 * Resolve the silent switch for an installer. Prefers winget's own `silent_args`;
 * falls back to the type default; for a bare `exe` with no winget switch, returns the
 * common `/S` guess flagged `guessed: true`.
 *
 * @param installerType winget installer_type (e.g. 'nullsoft', 'inno', 'exe', 'msi')
 * @param wingetSilentArgs the manifest's silent_args, if present (else null/empty)
 */
export function resolveSilentArgs(
  installerType: string,
  wingetSilentArgs?: string | null
): SilentArgsResult {
  const fromWinget = (wingetSilentArgs || '').trim();
  if (fromWinget) {
    return { args: fromWinget, guessed: false, source: 'winget' };
  }

  const t = (installerType || '').toLowerCase();
  const def = defaultSilentArgs(t);
  if (def !== null) {
    return { args: def, guessed: false, source: 'default' };
  }

  // Bare `exe` (or unknown type): no reliable default. `/S` is the most common
  // silent flag but is a guess — a wrong one hangs the install. Flag it.
  return { args: '/S', guessed: true, source: 'guess' };
}

export { RELIABLE_TYPES };
