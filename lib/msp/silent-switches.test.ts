import { describe, it, expect } from 'vitest';
import { extractSilentSwitches } from './silent-switches';

describe('extractSilentSwitches (web copy)', () => {
  it('preserves a bare KEY=VALUE switch (UPSTREAM-ISSUES.md #2, ACCEPT_EULA)', () => {
    expect(
      extractSilentSwitches('"PowerBIDesktopSetup.exe" /quiet /norestart ACCEPT_EULA=1', 'burn')
    ).toBe('/quiet /norestart ACCEPT_EULA=1');
  });

  it('preserves a switch value with no leading / or -, e.g. --campaign <id>', () => {
    expect(
      extractSilentSwitches('"vs_SSMS.exe" --quiet --wait --campaign 8f2c1e-some-campaign-id', 'burn')
    ).toBe('--quiet --wait --campaign 8f2c1e-some-campaign-id');
  });

  it('does not leak a hyphenated filename fragment into the switches', () => {
    expect(
      extractSilentSwitches('"PBIDesktopSetup-2026-07_x64.exe" /quiet /norestart ACCEPT_EULA=1', 'burn')
    ).toBe('/quiet /norestart ACCEPT_EULA=1');
  });

  it('handles an unquoted leading installer path', () => {
    expect(extractSilentSwitches('vs_SSMS.exe --quiet --wait', 'burn')).toBe('--quiet --wait');
  });

  it('strips the msiexec /i action + target and keeps the MSI properties', () => {
    expect(
      extractSilentSwitches('msiexec /i "app.msi" /qn ALLUSERS=1 /norestart', 'msi')
    ).toBe('/qn ALLUSERS=1 /norestart');
  });

  it('strips a /x {GUID} uninstall action', () => {
    expect(
      extractSilentSwitches('msiexec /x {4a1a21e3-0000-0000-0000-000000000000} /qn', 'msi')
    ).toBe('/qn');
  });

  it('falls back to the type default when there are no switches after the path', () => {
    expect(extractSilentSwitches('"7zip-setup.exe"', 'nullsoft')).toBe('/S');
  });

  it('falls back to default rather than emitting a bare -DeploymentType', () => {
    expect(
      extractSilentSwitches('-DeploymentType Install -DeployMode Silent', 'exe')
    ).toBe('/S');
  });
});
