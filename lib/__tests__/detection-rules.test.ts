import { describe, it, expect } from 'vitest';
import {
  generateDetectionRules,
  generateInstallCommand,
  generateUninstallCommand,
  validateDetectionRules,
} from '../detection-rules';
import type { NormalizedInstaller } from '@/types/winget';
import type {
  MsiDetectionRule,
  FileDetectionRule,
  RegistryDetectionRule,
  ScriptDetectionRule,
} from '@/types/intune';

describe('generateDetectionRules', () => {
  describe('Native uninstall-registry detection (MSI/WiX/exe/inno/nullsoft)', () => {
    it('detects MSI via its uninstall ProductCode key (install-source-agnostic, not the marker)', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.msi',
        sha256: 'abc123',
        type: 'msi',
        productCode: '{12345678-1234-1234-1234-123456789012}',
      };

      const rules = generateDetectionRules(installer, 'Google Chrome', 'Google.Chrome', '120.0.6099.130');

      expect(rules).toHaveLength(1);
      expect(rules[0].type).toBe('registry');
      const regRule = rules[0] as RegistryDetectionRule;
      expect(regRule.keyPath).toBe(
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{12345678-1234-1234-1234-123456789012}'
      );
      // Existence-based; NOT the IntuneGet marker, and no version compare.
      expect(regRule.detectionType).toBe('exists');
      expect(regRule.keyPath).not.toContain('IntuneGet');
      expect(regRule.valueName).toBeUndefined();
    });

    it('uses HKCU for a user-scoped install', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.msi',
        sha256: 'abc123',
        type: 'msi',
        scope: 'user',
        productCode: '{12345678-1234-1234-1234-123456789012}',
      };

      const rules = generateDetectionRules(installer, 'Test App', 'Publisher.TestApp', '1.2.3');

      const regRule = rules[0] as RegistryDetectionRule;
      expect(regRule.keyPath).toContain('HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows');
    });

    it('detects an exe/nullsoft app via its ARP DisplayName key (winget puts it in productCode)', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.exe',
        sha256: 'abc123',
        type: 'nullsoft',
        productCode: 'Notepad++',
      };

      const rules = generateDetectionRules(installer, 'Notepad++', 'Notepad++.Notepad++', '8.9.7');

      expect(rules).toHaveLength(1);
      expect(rules[0].type).toBe('registry');
      const regRule = rules[0] as RegistryDetectionRule;
      expect(regRule.keyPath).toBe(
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notepad++'
      );
      expect(regRule.detectionType).toBe('exists');
    });

    it('sets check32BitOn64System for x86 installers (WOW6432Node view)', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x86',
        url: 'https://example.com/app.msi',
        sha256: 'abc123',
        type: 'msi',
        productCode: '{ABCD1234-5678-90AB-CDEF-1234567890AB}',
      };

      const rules = generateDetectionRules(installer, 'Test App', 'Publisher.TestApp', '2.0.0');

      const regRule = rules[0] as RegistryDetectionRule;
      expect(regRule.check32BitOn64System).toBe(true);
    });

    it('falls back to folder detection when there is no productCode', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.exe',
        sha256: 'abc123',
        type: 'exe',
      };

      const rules = generateDetectionRules(installer, 'Test App', 'Publisher.TestApp', '1.0.0');

      expect(rules).toHaveLength(1);
      expect(rules[0].type).toBe('file');
      const fileRule = rules[0] as FileDetectionRule;
      expect(fileRule.path).toBe('%ProgramFiles%');
      expect(fileRule.detectionType).toBe('exists');
    });
  });

  describe('IntuneGet marker — last resort (zip/portable via PSADT only)', () => {
    it('uses the marker for a zip package when wingetId+version are present', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.zip',
        sha256: 'abc123',
        type: 'zip',
      };

      const rules = generateDetectionRules(installer, 'Test App', 'Publisher.TestApp', '1.0.0');

      expect(rules).toHaveLength(1);
      expect(rules[0].type).toBe('registry');
      const regRule = rules[0] as RegistryDetectionRule;
      expect(regRule.keyPath).toBe('HKEY_LOCAL_MACHINE\\SOFTWARE\\IntuneGet\\Apps\\Publisher_TestApp');
      expect(regRule.valueName).toBe('Version');
      expect(regRule.detectionType).toBe('version');
    });

    it('honors a custom marker root for the zip/portable path', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.zip',
        sha256: 'abc123',
        type: 'portable',
      };

      const rules = generateDetectionRules(
        installer,
        'Test App',
        'Publisher.TestApp',
        '1.0.0',
        'SOFTWARE\\Contoso\\Apps'
      );

      const regRule = rules[0] as RegistryDetectionRule;
      expect(regRule.keyPath).toBe('HKEY_LOCAL_MACHINE\\SOFTWARE\\Contoso\\Apps\\Publisher_TestApp');
    });

    it('falls back to folder detection for zip when wingetId/version are missing', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.zip',
        sha256: 'abc123',
        type: 'zip',
      };

      const rules = generateDetectionRules(installer, 'Test App');

      expect(rules).toHaveLength(1);
      expect(rules[0].type).toBe('file');
    });
  });

  describe('MSIX detection rules', () => {
    it('should generate script detection for MSIX with package family name', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.msix',
        sha256: 'abc123',
        type: 'msix',
        packageFamilyName: 'Microsoft.VSCode_8wekyb3d8bbwe',
      };

      const rules = generateDetectionRules(installer, 'VS Code');

      expect(rules).toHaveLength(1);
      expect(rules[0].type).toBe('script');
      const scriptRule = rules[0] as ScriptDetectionRule;
      expect(scriptRule.scriptContent).toContain('Get-AppxPackage');
      expect(scriptRule.scriptContent).toContain('Microsoft.VSCode');
      expect(scriptRule.enforceSignatureCheck).toBe(false);
      expect(scriptRule.runAs32Bit).toBe(false);
    });

    it('should fall back to folder detection when package family name is missing', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.msix',
        sha256: 'abc123',
        type: 'msix',
      };

      const rules = generateDetectionRules(installer, 'Test App');

      expect(rules).toHaveLength(1);
      expect(rules[0].type).toBe('file');
    });

    it('should handle APPX type same as MSIX', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.appx',
        sha256: 'abc123',
        type: 'appx',
        packageFamilyName: 'TestApp_abc123',
      };

      const rules = generateDetectionRules(installer, 'Test App');

      expect(rules).toHaveLength(1);
      expect(rules[0].type).toBe('script');
    });
  });

  describe('Folder detection rules', () => {
    it('should use %ProgramFiles% for x64 machine-scoped installs', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.exe',
        sha256: 'abc123',
        type: 'portable',
      };

      const rules = generateDetectionRules(installer, 'Test App');
      const fileRule = rules[0] as FileDetectionRule;

      expect(fileRule.path).toBe('%ProgramFiles%');
      expect(fileRule.check32BitOn64System).toBe(false);
    });

    it('should use %ProgramFiles(x86)% for x86 installs', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x86',
        url: 'https://example.com/app.exe',
        sha256: 'abc123',
        type: 'portable',
      };

      const rules = generateDetectionRules(installer, 'Test App');
      const fileRule = rules[0] as FileDetectionRule;

      expect(fileRule.path).toBe('%ProgramFiles(x86)%');
      expect(fileRule.check32BitOn64System).toBe(true);
    });

    it('should use %LOCALAPPDATA%\\Programs for user-scoped installs', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.exe',
        sha256: 'abc123',
        type: 'portable',
        scope: 'user',
      };

      const rules = generateDetectionRules(installer, 'Test App');
      const fileRule = rules[0] as FileDetectionRule;

      expect(fileRule.path).toBe('%LOCALAPPDATA%\\Programs');
    });

    it('should sanitize invalid folder name characters', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.exe',
        sha256: 'abc123',
        type: 'portable',
      };

      const rules = generateDetectionRules(installer, 'Test:App<v1>?');
      const fileRule = rules[0] as FileDetectionRule;

      expect(fileRule.fileOrFolderName).not.toContain(':');
      expect(fileRule.fileOrFolderName).not.toContain('<');
      expect(fileRule.fileOrFolderName).not.toContain('>');
      expect(fileRule.fileOrFolderName).not.toContain('?');
    });

    it('should truncate very long folder names', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.exe',
        sha256: 'abc123',
        type: 'portable',
      };

      const longName = 'A'.repeat(100);
      const rules = generateDetectionRules(installer, longName);
      const fileRule = rules[0] as FileDetectionRule;

      expect(fileRule.fileOrFolderName.length).toBeLessThanOrEqual(64);
    });

    it('should use "Application" as fallback for empty name', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/app.exe',
        sha256: 'abc123',
        type: 'portable',
      };

      const rules = generateDetectionRules(installer, '   ');
      const fileRule = rules[0] as FileDetectionRule;

      expect(fileRule.fileOrFolderName).toBe('Application');
    });
  });

  describe('Burn installer detection', () => {
    it('detects burn via its uninstall ProductCode key when present (native, not marker)', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/bundle.exe',
        sha256: 'abc123',
        type: 'burn',
        productCode: '{BURN0000-0000-0000-0000-000000000000}',
      };

      const rules = generateDetectionRules(installer, 'Burn Bundle', 'Publisher.Bundle', '3.0.0');

      expect(rules).toHaveLength(1);
      expect(rules[0].type).toBe('registry');
      const regRule = rules[0] as RegistryDetectionRule;
      expect(regRule.keyPath).toContain('CurrentVersion\\Uninstall\\{BURN0000');
      expect(regRule.keyPath).not.toContain('IntuneGet');
    });

    it('falls back to folder detection for burn without a productCode', () => {
      const installer: NormalizedInstaller = {
        architecture: 'x64',
        url: 'https://example.com/bundle.exe',
        sha256: 'abc123',
        type: 'burn',
      };

      const rules = generateDetectionRules(installer, 'Burn Bundle', 'Publisher.Bundle', '3.0.0');

      expect(rules).toHaveLength(1);
      expect(rules[0].type).toBe('file');
    });
  });
});

describe('generateInstallCommand', () => {
  it('should generate MSI install command', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/installer.msi',
      sha256: 'abc123',
      type: 'msi',
    };

    const command = generateInstallCommand(installer);

    expect(command).toContain('msiexec /i');
    expect(command).toContain('/qn');
    expect(command).toContain('ALLUSERS=1');
    expect(command).toContain('/norestart');
  });

  it('should generate user-scoped MSI install command', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/installer.msi',
      sha256: 'abc123',
      type: 'msi',
    };

    const command = generateInstallCommand(installer, 'user');

    expect(command).toContain('ALLUSERS=""');
  });

  it('should generate MSIX install command', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/installer.msix',
      sha256: 'abc123',
      type: 'msix',
    };

    const command = generateInstallCommand(installer);

    expect(command).toContain('Add-AppxPackage');
  });

  it('should use custom silent args when provided', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/installer.exe',
      sha256: 'abc123',
      type: 'exe',
      silentArgs: '/VERYSILENT /NORESTART',
    };

    const command = generateInstallCommand(installer);

    expect(command).toContain('/VERYSILENT /NORESTART');
  });

  it('should use default silent args for Inno installer', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/setup.exe',
      sha256: 'abc123',
      type: 'inno',
    };

    const command = generateInstallCommand(installer);

    expect(command).toContain('/VERYSILENT');
    expect(command).toContain('/SUPPRESSMSGBOXES');
    expect(command).toContain('/NORESTART');
  });

  it('should use default silent args for Nullsoft installer', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/setup.exe',
      sha256: 'abc123',
      type: 'nullsoft',
    };

    const command = generateInstallCommand(installer);

    expect(command).toContain('/S');
  });

  it('should append .exe for extensionless EXE URLs', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://dl.pstmn.io/download/version/11.82.1/windows_64',
      sha256: 'abc123',
      type: 'exe',
    };

    const command = generateInstallCommand(installer);

    expect(command).toContain('"windows_64.exe"');
  });

  it('should append .msi for extensionless MSI URLs', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/releases/installer',
      sha256: 'abc123',
      type: 'msi',
    };

    const command = generateInstallCommand(installer);

    expect(command).toContain('msiexec /i "installer.msi"');
  });

  it('should generate zip extraction command', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/app.zip',
      sha256: 'abc123',
      type: 'zip',
    };

    const command = generateInstallCommand(installer);

    expect(command).toContain('Expand-Archive');
    expect(command).toContain('-Force');
  });
});

describe('generateUninstallCommand', () => {
  it('should generate MSI uninstall command with product code', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/installer.msi',
      sha256: 'abc123',
      type: 'msi',
      productCode: '{12345678-1234-1234-1234-123456789012}',
    };

    const command = generateUninstallCommand(installer);

    expect(command).toContain('msiexec /x');
    expect(command).toContain('{12345678-1234-1234-1234-123456789012}');
    expect(command).toContain('/qn');
    expect(command).toContain('/norestart');
  });

  it('should generate placeholder MSI uninstall command without product code', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/installer.msi',
      sha256: 'abc123',
      type: 'msi',
    };

    const command = generateUninstallCommand(installer);

    expect(command).toContain('{PRODUCT_CODE}');
  });

  it('should generate MSIX uninstall marker with package family name', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/installer.msix',
      sha256: 'abc123',
      type: 'msix',
      packageFamilyName: 'Microsoft.VSCode_8wekyb3d8bbwe',
    };

    const command = generateUninstallCommand(installer);

    expect(command).toContain('MSIX_UNINSTALL:');
    expect(command).toContain('Microsoft.VSCode');
  });

  it('should generate registry uninstall command for EXE with display name', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/app.exe',
      sha256: 'abc123',
      type: 'exe',
    };

    const command = generateUninstallCommand(installer, 'Test Application');

    expect(command).toContain('REGISTRY_UNINSTALL:');
    expect(command).toContain('Test Application');
  });

  it('should delegate Inno uninstall to registry lookup when display name is provided', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/app.exe',
      sha256: 'abc123',
      type: 'inno',
    };

    const command = generateUninstallCommand(installer, 'Inno App');

    expect(command).toContain('REGISTRY_UNINSTALL:');
    expect(command).toContain('Inno App');
  });

  it('should fall back to generic uninstall for EXE without display name', () => {
    const installer: NormalizedInstaller = {
      architecture: 'x64',
      url: 'https://example.com/app.exe',
      sha256: 'abc123',
      type: 'exe',
    };

    const command = generateUninstallCommand(installer);

    expect(command).toBe('uninstall.exe /S');
  });
});

describe('validateDetectionRules', () => {
  it('should return valid for proper MSI rule', () => {
    const rules = [
      {
        type: 'msi' as const,
        productCode: '{12345678-1234-1234-1234-123456789012}',
        productVersionOperator: 'greaterThanOrEqual' as const,
      },
    ];

    const result = validateDetectionRules(rules);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should return invalid for MSI rule without product code', () => {
    const rules = [
      {
        type: 'msi' as const,
        productCode: '',
      },
    ];

    const result = validateDetectionRules(rules);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('MSI detection rule requires a product code');
  });

  it('should return valid for proper file rule', () => {
    const rules = [
      {
        type: 'file' as const,
        path: '%ProgramFiles%',
        fileOrFolderName: 'TestApp',
        detectionType: 'exists' as const,
      },
    ];

    const result = validateDetectionRules(rules);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should return invalid for file rule without path', () => {
    const rules = [
      {
        type: 'file' as const,
        path: '',
        fileOrFolderName: 'TestApp',
        detectionType: 'exists' as const,
      },
    ];

    const result = validateDetectionRules(rules);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('File/folder detection rule requires path and file or folder name');
  });

  it('should return invalid for registry rule without key path', () => {
    const rules = [
      {
        type: 'registry' as const,
        keyPath: '',
        detectionType: 'exists' as const,
      },
    ];

    const result = validateDetectionRules(rules);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Registry detection rule requires key path');
  });

  it('should return invalid for script rule with short content', () => {
    const rules = [
      {
        type: 'script' as const,
        scriptContent: 'exit 0',
        enforceSignatureCheck: false,
      },
    ];

    const result = validateDetectionRules(rules);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Script detection rule requires valid script content');
  });

  it('should return invalid for empty rules array', () => {
    const result = validateDetectionRules([]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('At least one detection rule is required');
  });

  it('should validate multiple rules and collect all errors', () => {
    const rules = [
      {
        type: 'msi' as const,
        productCode: '',
      },
      {
        type: 'file' as const,
        path: '',
        fileOrFolderName: '',
        detectionType: 'exists' as const,
      },
    ];

    const result = validateDetectionRules(rules);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});
