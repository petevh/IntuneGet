import { describe, expect, it } from 'vitest';
import { JobProcessor } from '../src/job-processor';
import type { PackagerConfig } from '../src/config';
import type { PackagingJob } from '../src/job-poller';

// Minimal config - JobProcessor's constructor only stores it and constructs
// IntuneUploader/JobPoller wiring, no I/O happens at construction time.
const config: PackagerConfig = {
  packagerId: 'test-packager',
  mode: 'api',
  supabase: { url: '', serviceRoleKey: '' },
  api: { url: 'https://example.test', key: 'test-key' },
  azure: { clientId: 'client', useManagedIdentity: false, clientSecret: 'secret' },
  polling: { interval: 5000, staleJobTimeout: 60000 },
  paths: { work: 'C:\\work', tools: 'C:\\tools' },
};

function makeJob(overrides: Partial<PackagingJob> = {}): PackagingJob {
  return {
    id: 'job-1',
    user_id: 'user-1',
    user_email: 'user@example.test',
    tenant_id: 'tenant-1',
    winget_id: '7zip.7zip',
    version: '26.02',
    display_name: '7-Zip',
    publisher: '7zip',
    architecture: 'x64',
    installer_type: 'nullsoft',
    installer_url: 'https://example.test/7zip-setup.exe',
    installer_sha256: 'abc123',
    install_command: '"7zip-setup.exe" /S',
    uninstall_command: '',
    install_scope: 'machine',
    detection_rules: [],
    package_config: null,
    status: 'processing',
    progress_percent: 0,
    created_at: '2026-07-19T00:00:00Z',
    ...overrides,
  };
}

// Access to private methods under test - accepted pattern here since these are
// pure decision/string-building functions with no natural public surface of
// their own; extracting them to a free function would just move the problem.
function processor() {
  return new JobProcessor(config, null) as unknown as {
    usesNativeBuild(job: PackagingJob): boolean;
    isMarkerDetectionRule(job: PackagingJob): boolean;
    buildNativeCommandLines(
      job: PackagingJob,
      installerFileName: string
    ): { install: string; uninstall: string; setupFilePath: string; uninstallScript: string | null };
    extractSilentSwitches(installCommand: string, installerType: string): string;
    getUninstallCommand(job: PackagingJob): string;
  };
}

const markerRule = {
  type: 'registry',
  keyPath: 'HKLM\\SOFTWARE\\IntuneGet\\Apps\\7zip_7zip',
  valueName: 'Version',
  detectionType: 'version',
  operator: 'greaterThanOrEqual',
  detectionValue: '26.02',
};

describe('usesNativeBuild', () => {
  it('stays on PSADT when detection_rules resolves to the marker rule (current state of every job)', () => {
    const job = makeJob({ detection_rules: [markerRule] });
    expect(processor().usesNativeBuild(job)).toBe(false);
  });

  it('is case-insensitive when matching the marker keyPath', () => {
    const job = makeJob({ detection_rules: [{ ...markerRule, keyPath: markerRule.keyPath.toLowerCase() }] });
    expect(processor().usesNativeBuild(job)).toBe(false);
  });

  it('goes native once detection_rules carries a non-marker rule (e.g. MSI product code)', () => {
    const job = makeJob({
      installer_type: 'msi',
      detection_rules: [{ type: 'msi', productCode: '{11111111-2222-3333-4444-555555555555}' }],
    });
    expect(processor().usesNativeBuild(job)).toBe(true);
  });

  it('forces PSADT for zip regardless of detection_rules', () => {
    const job = makeJob({
      installer_type: 'zip',
      detection_rules: [{ type: 'msi', productCode: '{11111111-2222-3333-4444-555555555555}' }],
    });
    expect(processor().usesNativeBuild(job)).toBe(false);
  });

  it('honors a custom registryMarkerPath when matching', () => {
    const job = makeJob({
      package_config: { psadtConfig: { registryMarkerPath: 'SOFTWARE\\Custom\\Root' } },
      detection_rules: [{ ...markerRule, keyPath: 'HKLM\\SOFTWARE\\Custom\\Root\\7zip_7zip' }],
    });
    expect(processor().usesNativeBuild(job)).toBe(false);
  });

  it('goes native for the post-native-first uninstall-registry rule (same type as the marker, different keyPath)', () => {
    // Regression test for the web-app native-first rewrite (f503777aa):
    // winget-catalog apps with a ProductCode now key detection off the
    // uninstall-registry key (e.g. Adobe Acrobat Reader) instead of the
    // IntuneGet marker. That rule is ALSO `type: 'registry'`, so this pins
    // that isMarkerDetectionRule distinguishes on keyPath, not just type -
    // a type-only check would misclassify this as the marker and wrongly
    // stay on PSADT.
    const job = makeJob({
      installer_type: 'burn',
      detection_rules: [
        {
          type: 'registry',
          keyPath:
            'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{AC76BA86-1033-FF00-7760-BC15014EA700}',
          detectionType: 'exists',
        },
      ],
    });
    expect(processor().usesNativeBuild(job)).toBe(true);
  });

  it('goes native for a folder-existence rule (no ProductCode available)', () => {
    const job = makeJob({
      installer_type: 'nullsoft',
      detection_rules: [
        {
          type: 'file',
          path: '%ProgramFiles%',
          fileOrFolderName: 'Some App',
          detectionType: 'exists',
        },
      ],
    });
    expect(processor().usesNativeBuild(job)).toBe(true);
  });
});

describe('buildNativeCommandLines', () => {
  it('builds default exe-family install/uninstall with a generated Uninstall.ps1', () => {
    const job = makeJob();
    const result = processor().buildNativeCommandLines(job, '7zip-setup.exe');

    expect(result.install).toBe('"7zip-setup.exe" /S');
    expect(result.uninstall).toBe('powershell.exe -ExecutionPolicy Bypass -File Uninstall.ps1');
    expect(result.setupFilePath).toBe('7zip-setup.exe');
    expect(result.uninstallScript).toContain("$name = '7-Zip'");
    expect(result.uninstallScript).toContain('QuietUninstallString');
  });

  it('builds an msiexec uninstall script (not a bare command line) for MSI using the product code when present', () => {
    // Regression test for a live failure: a bare `msiexec /x {code} /qn
    // /norestart` uninstallCommandLine races Intune's own post-enforcement
    // detection re-check - msiexec's front-end process can exit before
    // Windows Installer actually finishes committing the removal, so the
    // near-immediate re-check still sees the old registry state and Intune
    // reports the uninstall as failed even though it succeeds moments
    // later (confirmed live against Adobe Acrobat Reader). The uninstall
    // must go through a script that waits on the Global\_MSIExecute mutex.
    const job = makeJob({
      installer_type: 'msi',
      install_command: '"app.msi"',
      uninstall_command: 'msiexec /x {11111111-2222-3333-4444-555555555555} /qn',
    });
    const result = processor().buildNativeCommandLines(job, 'app.msi');

    expect(result.install).toBe('msiexec /i "app.msi" /qn /norestart');
    expect(result.uninstall).toBe('powershell.exe -ExecutionPolicy Bypass -File Uninstall.ps1');
    expect(result.uninstallScript).toContain('/x {11111111-2222-3333-4444-555555555555} /qn /norestart');
    expect(result.uninstallScript).toContain("OpenExisting('Global\\_MSIExecute')");
  });

  it('falls back to a filename-based msiexec target when no product code is present', () => {
    const job = makeJob({ installer_type: 'msi', install_command: '"app.msi"', uninstall_command: '' });
    const result = processor().buildNativeCommandLines(job, 'app.msi');

    expect(result.uninstall).toBe('powershell.exe -ExecutionPolicy Bypass -File Uninstall.ps1');
    expect(result.uninstallScript).toContain('/x "app.msi" /qn /norestart');
  });

  it('uses a direct msiexec uninstall for an exe installer that wraps an MSI, when detection knows the ProductCode', () => {
    // Regression test for a live failure: Adobe Acrobat Reader's manifest
    // declares installer_type "exe" (it's a bootstrapper) but also a real MSI
    // ProductCode. Native-first detection already resolved that ProductCode
    // into an uninstall-registry rule; buildNativeCommandLines previously only
    // checked installer_type for "msi"/"wix" and ignored it, so it fell to the
    // generic Uninstall.ps1 script - which for this app would have run the
    // wrong msiexec verb (the registered UninstallString uses /I, not /X) with
    // mismatched exe-install switches appended, and not actually uninstalled it.
    const job = makeJob({
      installer_type: 'exe',
      install_command: '"AcroRdrDCx64.exe" /sAll /msi EULA_ACCEPT=YES',
      uninstall_command: 'REGISTRY_UNINSTALL:Adobe Acrobat Reader (64-bit)',
      detection_rules: [
        {
          type: 'registry',
          keyPath:
            'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{AC76BA86-1033-FF00-7760-BC15014EA700}',
          detectionType: 'exists',
        },
      ],
    });
    const result = processor().buildNativeCommandLines(job, 'AcroRdrDCx64.exe');

    expect(result.install).toBe('"AcroRdrDCx64.exe" /sAll /msi EULA_ACCEPT=YES');
    expect(result.uninstall).toBe('powershell.exe -ExecutionPolicy Bypass -File Uninstall.ps1');
    expect(result.uninstallScript).toContain('/x {AC76BA86-1033-FF00-7760-BC15014EA700} /qn /norestart');
    expect(result.uninstallScript).toContain("OpenExisting('Global\\_MSIExecute')");
  });

  it('still falls back to the generic Uninstall.ps1 script for a non-MSI exe with no ProductCode anywhere', () => {
    const job = makeJob({
      installer_type: 'nullsoft',
      detection_rules: [
        { type: 'file', path: '%ProgramFiles%', fileOrFolderName: 'Some App', detectionType: 'exists' },
      ],
    });
    const result = processor().buildNativeCommandLines(job, '7zip-setup.exe');

    expect(result.uninstall).toBe('powershell.exe -ExecutionPolicy Bypass -File Uninstall.ps1');
    expect(result.uninstallScript).not.toBeNull();
  });

  it('uses winget real switches (not a per-type guess) when install_command carries them', () => {
    // Regression test for a live failure: SSMS's real switches are
    // `--quiet --wait --campaign <id>` (installer_type not recognized as a
    // known default), but buildNativeCommandLines previously called
    // resolveSilentArgs(job.installer_type) with no winget args at all, so it
    // always fell back to a guessed `/S` - which SSMS's installer doesn't
    // understand, causing it to hang instead of installing silently.
    const job = makeJob({
      installer_type: 'burn',
      install_command: '"vs_SSMS.exe" --quiet --wait --campaign 8f2c1e-some-campaign-id',
    });
    const result = processor().buildNativeCommandLines(job, 'vs_SSMS.exe');

    expect(result.install).toBe('"vs_SSMS.exe" --quiet --wait --campaign 8f2c1e-some-campaign-id');
  });

  it('falls back to the per-type default when install_command carries no separate switches', () => {
    const job = makeJob({ installer_type: 'burn', install_command: '"vs_SSMS.exe"' });
    const result = processor().buildNativeCommandLines(job, 'vs_SSMS.exe');

    expect(result.install).toBe('"vs_SSMS.exe" /q /norestart');
  });

  it('prefers the psadtConfig install/uninstall override over any default', () => {
    const job = makeJob({
      package_config: {
        psadtConfig: {
          installCommand: 'custom-install.cmd /quiet',
          uninstallCommand: 'custom-uninstall.cmd /quiet',
        },
      },
    });
    const result = processor().buildNativeCommandLines(job, '7zip-setup.exe');

    expect(result.install).toBe('custom-install.cmd /quiet');
    expect(result.uninstall).toBe('custom-uninstall.cmd /quiet');
    expect(result.uninstallScript).toBeNull();
  });
});

describe('extractSilentSwitches', () => {
  it('preserves a bare KEY=VALUE switch (UPSTREAM-ISSUES.md #2, ACCEPT_EULA)', () => {
    const result = processor().extractSilentSwitches(
      '"PowerBIDesktopSetup.exe" /quiet /norestart ACCEPT_EULA=1',
      'burn'
    );
    expect(result).toBe('/quiet /norestart ACCEPT_EULA=1');
  });

  it('preserves a switch whose value has no leading / or -, e.g. --campaign <id>', () => {
    const result = processor().extractSilentSwitches(
      '"vs_SSMS.exe" --quiet --wait --campaign 8f2c1e-some-campaign-id',
      'burn'
    );
    expect(result).toBe('--quiet --wait --campaign 8f2c1e-some-campaign-id');
  });

  it('does not leak a hyphenated filename fragment into the switches', () => {
    const result = processor().extractSilentSwitches(
      '"PBIDesktopSetup-2026-07_x64.exe" /quiet /norestart ACCEPT_EULA=1',
      'burn'
    );
    expect(result).toBe('/quiet /norestart ACCEPT_EULA=1');
  });

  it('handles an unquoted leading installer path', () => {
    const result = processor().extractSilentSwitches('vs_SSMS.exe --quiet --wait', 'burn');
    expect(result).toBe('--quiet --wait');
  });

  it('KNOWN LIMITATION: mis-splits an unquoted path containing spaces', () => {
    // generateInstallCommand (web app, detection-rules.ts) always quotes the
    // installer path, so this input doesn't occur in practice - documenting the
    // current (wrong) behavior rather than a requirement, per UPSTREAM-ISSUES.md #2.
    const result = processor().extractSilentSwitches('C:\\Program Files\\App\\setup.exe /S', 'exe');
    expect(result).toBe('Files\\App\\setup.exe /S');
  });

  it('falls back to the type default when there are no switches after the path', () => {
    const result = processor().extractSilentSwitches('"7zip-setup.exe"', 'nullsoft');
    expect(result).toBe('/S');
  });

  it('falls back to default rather than emitting a bare -DeploymentType', () => {
    const result = processor().extractSilentSwitches(
      '-DeploymentType Install -DeployMode Silent',
      'exe'
    );
    expect(result).toBe('/S');
  });
});

describe('getUninstallCommand (REGISTRY_UNINSTALL / MSIX_UNINSTALL markers)', () => {
  // Regression tests for a live failure: lib/detection-rules.ts (web app)
  // emits REGISTRY_UNINSTALL:<displayName> / MSIX_UNINSTALL:<name> marker
  // strings for exe/inno/nullsoft/burn and msix/appx installers respectively
  // - not literal commands. .github/scripts/Create-PSADTPackage.ps1 already
  // resolves these into real PSADT v4 calls; the self-hosted packager didn't,
  // so it shelled out to the literal marker text via cmd.exe and failed with
  // exit code 1 (confirmed live against Adobe Acrobat Reader's uninstall).

  it('resolves REGISTRY_UNINSTALL into Get-ADTApplication/Uninstall-ADTApplication, stripping the winget suffix', () => {
    const job = makeJob({
      winget_id: 'Adobe.Acrobat.Reader.64-bit',
      uninstall_command: 'REGISTRY_UNINSTALL:Adobe Acrobat Reader (64-bit)',
    });
    const result = processor().getUninstallCommand(job);

    expect(result).not.toContain('REGISTRY_UNINSTALL');
    expect(result).toContain("$appName = 'Adobe Acrobat Reader'");
    expect(result).toContain('Get-ADTApplication -Name $appName');
    expect(result).toContain('Uninstall-ADTApplication -Name $appName');
    expect(result).toContain("$wingetId = 'Adobe.Acrobat.Reader.64-bit'");
    expect(result).toContain('winget uninstall --id $wingetId');
  });

  it('resolves MSIX_UNINSTALL into Get-AppxPackage/Remove-AppxPackage', () => {
    const job = makeJob({
      installer_type: 'msix',
      uninstall_command: 'MSIX_UNINSTALL:Contoso.App',
    });
    const result = processor().getUninstallCommand(job);

    expect(result).not.toContain('MSIX_UNINSTALL');
    expect(result).toContain("$packageName = 'Contoso.App'");
    expect(result).toContain('Get-AppxPackage -Name "*$packageName*"');
    expect(result).toContain('Remove-AppxPackage');
  });

  it('still prefers an MSI product code over any marker', () => {
    const job = makeJob({
      installer_type: 'msi',
      uninstall_command: 'msiexec /x {11111111-2222-3333-4444-555555555555} /qn',
    });
    const result = processor().getUninstallCommand(job);

    expect(result).toBe(
      "Start-ADTMsiProcess -Action 'Uninstall' -ProductCode '{11111111-2222-3333-4444-555555555555}' -SuccessExitCodes @(0, 1605, 1614, 3010, 1641)"
    );
  });

  it('still falls back to a literal command when uninstall_command is not a marker', () => {
    const job = makeJob({ uninstall_command: '"C:\\Program Files\\App\\uninst.exe" /S' });
    const result = processor().getUninstallCommand(job);

    expect(result).toContain('Start-ADTProcess');
    expect(result).toContain('uninst.exe');
  });
});
