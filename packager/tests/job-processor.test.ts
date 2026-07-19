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

  it('builds msiexec install/uninstall for MSI using the product code when present', () => {
    const job = makeJob({
      installer_type: 'msi',
      uninstall_command: 'msiexec /x {11111111-2222-3333-4444-555555555555} /qn',
    });
    const result = processor().buildNativeCommandLines(job, 'app.msi');

    expect(result.install).toBe('msiexec /i "app.msi" /qn /norestart');
    expect(result.uninstall).toBe('msiexec /x {11111111-2222-3333-4444-555555555555} /qn /norestart');
    expect(result.uninstallScript).toBeNull();
  });

  it('falls back to a filename-based msiexec uninstall when no product code is present', () => {
    const job = makeJob({ installer_type: 'msi', uninstall_command: '' });
    const result = processor().buildNativeCommandLines(job, 'app.msi');

    expect(result.uninstall).toBe('msiexec /x "app.msi" /qn /norestart');
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
