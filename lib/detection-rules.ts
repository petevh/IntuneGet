/**
 * Detection Rule Engine
 * Auto-generates Intune detection rules based on installer type
 *
 * Uses simple folder existence detection
 * Example: %ProgramFiles%\Git - just check if the folder exists
 */

import type {
  DetectionRule,
  FileDetectionRule,
  MsiDetectionRule,
  RegistryDetectionRule,
  ScriptDetectionRule,
} from '@/types/intune';
import type { NormalizedInstaller, WingetInstallerType, WingetScope } from '@/types/winget';
import { resolveInstallerFileName } from '@/lib/installer-filename';
import { normalizeMarkerPath } from '@/lib/registry-marker';

/**
 * Generate detection rules based on installer metadata.
 *
 * NATIVE-FIRST strategy (changed 2026-07-19 — see docker-homelab intuneget/DESIGN.md §2).
 * The previous strategy preferred the IntuneGet registry marker
 * (`HKLM\SOFTWARE\IntuneGet\Apps\{id}`) for every installer type. That marker is written
 * only by the PSADT install script, so (a) it breaks entirely once packaging moves off
 * PSADT, and (b) — more importantly — it only detects apps IntuneGet installed. An app put
 * on the machine by IT, by the user, or by an older package has no marker, so Intune
 * reports "not installed" and re-pushes it. Native detection sees the app itself, however
 * it got there. So the order is now:
 *
 * 1. MSIX/APPX  → PackageFamilyName script (the only correct MSIX detection).
 * 2. Uninstall-registry key existence — from the manifest ProductCode (GUID for MSI/WiX,
 *    ARP DisplayName for exe/inno/nullsoft). Install-source-agnostic. EXISTENCE-based
 *    (no version comparison — NormalizedInstaller lacks DisplayVersion).
 * 3. Folder existence — when there is no ProductCode to key on.
 * 4. IntuneGet PSADT marker — LAST RESORT, only for the Tier-5 tail (zip/portable and
 *    markerless exe that must still be packaged by PSADT). Requires wingetId+version.
 *
 * NOTE the staleness caveat that motivated the old marker-first choice: a raw MSI
 * ProductCode as an Intune *MSI* rule goes stale when vendors rotate the code each release.
 * We avoid that by detecting the uninstall-KEY existence, not by matching the ProductCode
 * value in an MSI rule — the uninstall key is more stable than an exact-GUID MSI match, and
 * existence detection is version-agnostic by construction.
 *
 * @param installer - Normalized installer metadata
 * @param displayName - Application display name
 * @param wingetId - Optional Winget package ID (for the marker fallback only)
 * @param version - Optional version (for the marker fallback only)
 * @param markerPath - Optional custom registry marker root (psadtConfig.registryMarkerPath)
 */
export function generateDetectionRules(
  installer: NormalizedInstaller,
  displayName: string,
  wingetId?: string,
  version?: string,
  markerPath?: string
): DetectionRule[] {
  // MSIX/APPX: only PFN script detection is correct.
  if (installer.type === 'msix' || installer.type === 'appx') {
    return generateMsixDetectionRules(installer, displayName);
  }

  // Native, install-source-agnostic: uninstall-registry key existence (MSI GUID or ARP
  // DisplayName from the manifest ProductCode). Covers msi/wix/exe/inno/nullsoft/burn and
  // anything else that carries a ProductCode.
  const uninstallRule = generateUninstallRegistryDetectionRules(installer);
  if (uninstallRule) {
    return uninstallRule;
  }

  // No ProductCode (e.g. many zip/portable, and some exe): fall back to folder existence.
  // Only if that too is unusable do we reach for the PSADT marker — which detects just
  // IntuneGet's own installs and requires the PSADT path to have written it.
  if (installer.type === 'zip' || installer.type === 'portable') {
    if (wingetId && version) {
      return generateRegistryMarkerDetectionRules(wingetId, version, installer.scope, markerPath);
    }
    return generateFolderDetectionRules(installer, displayName);
  }

  return generateFolderDetectionRules(installer, displayName);
}

/**
 * Generate registry marker detection rules
 * Uses IntuneGet's custom registry marker written by PSADT during installation
 *
 * This provides 100% reliable detection because:
 * - We control exactly what's written to the registry
 * - Works regardless of where the app actually installs
 * - Supports version comparison for upgrade detection
 * - Marker is removed on uninstall
 *
 * Registry path: HKLM:\SOFTWARE\IntuneGet\Apps\{WingetId_sanitized}
 * For user scope: HKCU:\SOFTWARE\IntuneGet\Apps\{WingetId_sanitized}
 * The SOFTWARE\IntuneGet\Apps root is customizable per package via
 * psadtConfig.registryMarkerPath (issue #106)
 */
function generateRegistryMarkerDetectionRules(
  wingetId: string,
  version: string,
  scope?: WingetScope,
  markerPath?: string
): DetectionRule[] {
  // Sanitize wingetId: replace . and - with _ to create valid registry key name
  const sanitizedId = wingetId.replace(/[\.\-]/g, '_');

  // Use HKCU for user scope, HKLM for machine scope (default)
  const hive = scope === 'user' ? 'HKEY_CURRENT_USER' : 'HKEY_LOCAL_MACHINE';

  return [
    {
      type: 'registry',
      keyPath: `${hive}\\${normalizeMarkerPath(markerPath)}\\${sanitizedId}`,
      valueName: 'Version',
      check32BitOn64System: false,
      detectionType: 'version',
      operator: 'greaterThanOrEqual',
      detectionValue: version,
    } as RegistryDetectionRule,
  ];
}


/**
 * Generate uninstall-registry detection rules — NATIVE, install-source-agnostic.
 *
 * Checks for the app's Add/Remove Programs (Uninstall) registry key, so it detects the
 * app HOWEVER it was installed — by Intune, by an admin, by the user, or by an older
 * non-IntuneGet package. This is the key advantage over the IntuneGet marker, which only
 * detects apps IntuneGet itself installed.
 *
 * The uninstall subkey name comes from winget's `ProductCode`:
 *  - MSI/WiX: the ProductCode GUID (e.g. `{7F0F0C51-...}`)
 *  - exe/inno/nullsoft: winget puts the ARP DisplayName / uninstall key there
 *    (e.g. `Notepad++`, `Mozilla Firefox 145.0 (x64 en-US)`)
 *
 * EXISTENCE-based (not version-compared): NormalizedInstaller does not carry
 * DisplayVersion, so this detects "installed at all", not "installed at >= this version".
 * Good enough for presence; version-aware upgrade detection would need
 * AppsAndFeaturesEntries plumbed through (see DESIGN.md §2). Returns null when there is no
 * usable ProductCode, so the caller can fall back.
 */
function generateUninstallRegistryDetectionRules(
  installer: NormalizedInstaller
): DetectionRule[] | null {
  const key = installer.productCode?.trim();
  if (!key) return null;

  // User-scope apps register under HKCU; machine scope (default) under HKLM. On 64-bit
  // Windows, 32-bit installers write to the WOW6432Node view — check32BitOn64System.
  const hive = installer.scope === 'user' ? 'HKEY_CURRENT_USER' : 'HKEY_LOCAL_MACHINE';
  const keyPath = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${key}`;

  return [
    {
      type: 'registry',
      keyPath,
      // No valueName: key existence alone is the detection.
      detectionType: 'exists',
      check32BitOn64System: installer.architecture === 'x86',
    } as RegistryDetectionRule,
  ];
}

/**
 * Generate MSIX/APPX detection rules
 * MSIX apps require script-based detection using Package Family Name
 */
function generateMsixDetectionRules(
  installer: NormalizedInstaller,
  displayName: string
): DetectionRule[] {
  if (installer.packageFamilyName) {
    return [
      {
        type: 'script',
        scriptContent: generateMsixDetectionScript(installer.packageFamilyName),
        enforceSignatureCheck: false,
        runAs32Bit: false,
      } as ScriptDetectionRule,
    ];
  }

  // Fallback: folder detection
  return generateFolderDetectionRules(installer, displayName);
}

/**
 * Generate folder existence detection rules (RoboPack approach)
 * Simple and reliable: just check if %ProgramFiles%\AppName exists
 */
function generateFolderDetectionRules(
  installer: NormalizedInstaller,
  displayName: string
): DetectionRule[] {
  const folderName = inferFolderName(displayName);
  const basePath = getBasePath(installer.scope, installer.architecture);

  return [
    {
      type: 'file',
      path: basePath,
      fileOrFolderName: folderName,
      detectionType: 'exists',
      check32BitOn64System: installer.architecture === 'x86',
    } as FileDetectionRule,
  ];
}

/**
 * Infer the installation folder name from display name
 *
 * Examples:
 * - "Git" -> "Git"
 * - "Visual Studio Code" -> "Microsoft VS Code" (common alias, but we use display name)
 * - "7-Zip" -> "7-Zip"
 *
 * Most apps use their display name or a simplified version as folder name
 */
function inferFolderName(displayName: string): string {
  // Keep the original name but remove characters that are invalid for folder names
  // Valid folder name characters: letters, numbers, spaces, hyphens, underscores, periods
  let folderName = displayName.replace(/[<>:"/\\|?*]/g, '').trim();

  // If the name is too long, truncate it (Windows path limit considerations)
  if (folderName.length > 64) {
    folderName = folderName.substring(0, 64).trim();
  }

  return folderName || 'Application';
}

/**
 * Get the base installation path based on scope and architecture
 */
function getBasePath(scope?: WingetScope, architecture?: string): string {
  if (scope === 'user') {
    return '%LOCALAPPDATA%\\Programs';
  }

  // For machine scope, check architecture
  if (architecture === 'x86') {
    return '%ProgramFiles(x86)%';
  }

  return '%ProgramFiles%';
}

/**
 * Generate MSIX detection script
 * MSIX apps are detected via Get-AppxPackage
 */
function generateMsixDetectionScript(packageFamilyName: string): string {
  // Extract the package name (before the underscore in family name)
  const packageName = packageFamilyName.split('_')[0];

  const lines = [
    '# MSIX Detection Script',
    `# Package Family Name: ${packageFamilyName}`,
    '',
    '$ErrorActionPreference = "SilentlyContinue"',
    `$package = Get-AppxPackage -Name "*${packageName}*" -AllUsers`,
    'if ($package) {',
    '    Write-Output "Installed"',
    '    exit 0',
    '}',
    'exit 1',
  ];

  return lines.join('\n');
}

/**
 * Generate install command based on installer type
 */
export function generateInstallCommand(
  installer: NormalizedInstaller,
  scope: WingetScope = 'machine'
): string {
  const installerName = resolveInstallerFileName(installer.url, installer.type);
  const silentArgs = resolveSilentArgs(installer);

  switch (installer.type) {
    case 'msi':
    case 'wix':
      const msiScope = scope === 'user' ? 'ALLUSERS=""' : 'ALLUSERS=1';
      return `msiexec /i "${installerName}" /qn ${msiScope} /norestart`;

    case 'msix':
    case 'appx':
      return `Add-AppxPackage -Path "${installerName}"`;

    case 'exe':
    case 'inno':
    case 'nullsoft':
    case 'burn':
      return `"${installerName}" ${silentArgs}`.trim();

    case 'zip':
    case 'portable':
      return `Expand-Archive -Path "${installerName}" -DestinationPath "%ProgramFiles%\\${installerName.replace(/\.[^/.]+$/, '')}" -Force`;

    default:
      return `"${installerName}" ${silentArgs}`.trim();
  }
}

/**
 * Generate uninstall command based on installer type
 *
 * For EXE/Inno/Nullsoft installers, we generate a registry-based lookup command
 * because the generic commands (uninstall.exe /S) don't work - the uninstaller
 * is located in the app's install directory, not the current working directory.
 *
 * @param installer - Normalized installer metadata
 * @param displayName - Application display name for registry lookup
 */
export function generateUninstallCommand(
  installer: NormalizedInstaller,
  displayName?: string
): string {
  switch (installer.type) {
    case 'msi':
    case 'wix':
      if (installer.productCode) {
        return `msiexec /x "${installer.productCode}" /qn /norestart`;
      }
      return 'msiexec /x {PRODUCT_CODE} /qn /norestart';

    case 'msix':
    case 'appx':
      // Return marker for MSIX/APPX uninstall - handled specially in PSADT workflow
      if (installer.packageFamilyName) {
        return `MSIX_UNINSTALL:${installer.packageFamilyName.split('_')[0]}`;
      }
      // Fallback using display name
      if (displayName) {
        return `MSIX_UNINSTALL:${displayName}`;
      }
      return 'MSIX_UNINSTALL:{PACKAGE_NAME}';

    case 'exe':
    case 'inno':
    case 'nullsoft':
    case 'burn':
      // Use registry-based uninstall lookup for EXE installers
      // This finds the actual UninstallString from the registry and executes it
      if (displayName) {
        return generateRegistryUninstallCommand(displayName, installer.type);
      }
      // Fallback to generic commands (less reliable)
      if (installer.type === 'inno') {
        return 'unins000.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART';
      }
      return 'uninstall.exe /S';

    default:
      if (displayName) {
        return generateRegistryUninstallCommand(displayName, 'exe');
      }
      return '# Manual uninstall required';
  }
}

/**
 * Generate a registry-based uninstall command
 *
 * Returns a marker that tells Create-PSADTPackage.ps1 to use
 * Uninstall-ADTApplication with the display name. PSADT handles
 * registry lookup, MSI vs EXE detection, and silent switches
 * automatically via the app's registered QuietUninstallString.
 */
function generateRegistryUninstallCommand(
  displayName: string,
  _installerType: string
): string {
  return `REGISTRY_UNINSTALL:${displayName}`;
}

/**
 * Get default silent arguments based on installer type
 */
/**
 * Resolve the silent install switches for an installer, as a structured string.
 *
 * This is the single source of truth for the exe-family silent switches, and the
 * value that must be carried to the packager verbatim. It preserves whatever the
 * manifest normalization produced (`installer.silentArgs`, which already folds in
 * `InstallerSwitches.Custom` such as `ACCEPT_EULA=1`), falling back to the
 * per-type default only when the manifest declared no switches.
 *
 * Callers must NOT re-derive switches by re-parsing a built install-command
 * string — that round-trip silently drops bare `KEY=VALUE` switches. See
 * UPSTREAM-ISSUES.md #2.
 */
export function resolveSilentArgs(installer: NormalizedInstaller): string {
  return installer.silentArgs || getDefaultSilentArgs(installer.type);
}

export function getDefaultSilentArgs(type: WingetInstallerType): string {
  const defaults: Record<WingetInstallerType, string> = {
    msi: '/qn /norestart',
    msix: '',
    appx: '',
    exe: '/S',
    inno: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART',
    nullsoft: '/S',
    wix: '/qn /norestart',
    burn: '/quiet /norestart',
    zip: '',
    pwa: '',
    portable: '',
  };

  return defaults[type] || '';
}

/**
 * Validate detection rules
 */
export function validateDetectionRules(rules: DetectionRule[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (rules.length === 0) {
    errors.push('At least one detection rule is required');
  }

  for (const rule of rules) {
    switch (rule.type) {
      case 'msi':
        if (!(rule as MsiDetectionRule).productCode) {
          errors.push('MSI detection rule requires a product code');
        }
        break;

      case 'file':
        const fileRule = rule as FileDetectionRule;
        if (!fileRule.path || !fileRule.fileOrFolderName) {
          errors.push('File/folder detection rule requires path and file or folder name');
        }
        break;

      case 'registry':
        const regRule = rule as RegistryDetectionRule;
        if (!regRule.keyPath) {
          errors.push('Registry detection rule requires key path');
        }
        break;

      case 'script':
        const scriptRule = rule as ScriptDetectionRule;
        if (!scriptRule.scriptContent || scriptRule.scriptContent.length < 10) {
          errors.push('Script detection rule requires valid script content');
        }
        break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
