/**
 * Silent Switches Extraction
 * Shared module for extracting silent install switches from install commands
 */

/**
 * Extract silent switches from the install command
 */
export function extractSilentSwitches(installCommand: string, installerType: string): string {
  // Common silent switches by installer type
  const defaultSwitches: Record<string, string> = {
    msi: '/qn /norestart',
    exe: '/S',
    inno: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART',
    nullsoft: '/S',
    wix: '/qn /norestart',
    burn: '/q /norestart',
    msix: '', // MSIX doesn't need switches
  };

  // Strip executable path first (handles paths with hyphens like "7z2501-x64.exe")
  // This removes everything up to and including common installer extensions
  let cleaned = installCommand
    .replace(/^msiexec(?:\.exe)?\s+/i, '') // Remove a leading bare `msiexec` / `msiexec.exe`
    .replace(/^"[^"]+"\s*/, '') // Remove quoted paths like "C:\path\installer.exe"
    .replace(/^\S+\.(exe|msi|msix|appx)\s*/i, ''); // Remove unquoted paths ending in installer extensions

  // Strip msiexec action switches and their targets:
  // /i filename.msi, /x {GUID}, /p patch.msp, etc.
  cleaned = cleaned
    .replace(/\/[ixp]\s+"[^"]+"\s*/gi, '') // /i "quoted path.msi"
    .replace(/\/[ixp]\s+\{[^}]+\}\s*/gi, '') // /x {GUID}
    .replace(/\/[ixp]\s+\S+\.(msi|msp)\s*/gi, '') // /i filename.msi
    .replace(/\/[ixp]\s+/gi, ''); // /i alone (leftover)

  // Whatever remains after stripping the installer path and any msiexec action
  // switches IS the switch list — return it verbatim. The previous approach
  // pattern-matched only /- or --prefixed tokens and stopped at the first token
  // that didn't start with / or -, which silently dropped bare KEY=VALUE
  // switches (ACCEPT_EULA=1, ALLUSERS=1, a --campaign <id> value, etc.). See
  // UPSTREAM-ISSUES.md #2. Prefer the normalized silentArgs carried as
  // structured data (resolveSilentArgs); this extractor is now only a fallback
  // for command strings we can't otherwise resolve.
  const switches = cleaned.trim();
  if (switches && !switches.startsWith('-DeploymentType')) {
    return switches;
  }

  return defaultSwitches[installerType] || '/S';
}
