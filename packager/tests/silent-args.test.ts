import { describe, expect, it } from 'vitest';
import { resolveSilentArgs, defaultSilentArgs } from '../src/silent-args';

describe('defaultSilentArgs', () => {
  it('returns the known-good switch for reliable installer types', () => {
    expect(defaultSilentArgs('msi')).toBe('/qn /norestart');
    expect(defaultSilentArgs('wix')).toBe('/qn /norestart');
    expect(defaultSilentArgs('inno')).toBe('/VERYSILENT /SUPPRESSMSGBOXES /NORESTART');
    expect(defaultSilentArgs('nullsoft')).toBe('/S');
    expect(defaultSilentArgs('burn')).toBe('/q /norestart');
  });

  it('treats MSIX/AppX as silent-by-nature (empty switch, not null)', () => {
    expect(defaultSilentArgs('msix')).toBe('');
    expect(defaultSilentArgs('appx')).toBe('');
  });

  it('is case-insensitive on the installer type', () => {
    expect(defaultSilentArgs('MSI')).toBe('/qn /norestart');
    expect(defaultSilentArgs('NullSoft')).toBe('/S');
  });

  it('returns null for a bare exe — no reliable universal default (DESIGN §3)', () => {
    expect(defaultSilentArgs('exe')).toBeNull();
  });

  it('returns null for unknown types', () => {
    expect(defaultSilentArgs('totally-unknown')).toBeNull();
  });
});

describe('resolveSilentArgs', () => {
  it("prefers winget's own silent_args over any default", () => {
    expect(resolveSilentArgs('nullsoft', '/S /D=C:\\x')).toEqual({
      args: '/S /D=C:\\x',
      guessed: false,
      source: 'winget',
    });
    // winget value wins even when the type would otherwise be a guess
    expect(resolveSilentArgs('exe', '/quiet')).toEqual({
      args: '/quiet',
      guessed: false,
      source: 'winget',
    });
  });

  it('falls back to the type default when winget has no switch', () => {
    expect(resolveSilentArgs('inno', null)).toEqual({
      args: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART',
      guessed: false,
      source: 'default',
    });
    expect(resolveSilentArgs('msi', '')).toEqual({
      args: '/qn /norestart',
      guessed: false,
      source: 'default',
    });
  });

  it('flags a bare exe with no winget switch as a guess (could hang unattended)', () => {
    const r = resolveSilentArgs('exe', null);
    expect(r.args).toBe('/S');
    expect(r.guessed).toBe(true);
    expect(r.source).toBe('guess');
  });

  it('treats an unknown installer type as a guess', () => {
    expect(resolveSilentArgs('weird-installer', null).guessed).toBe(true);
  });

  it('ignores whitespace-only winget args and falls back', () => {
    expect(resolveSilentArgs('msi', '   ').source).toBe('default');
  });
});
