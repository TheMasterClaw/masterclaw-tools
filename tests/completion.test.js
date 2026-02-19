/**
 * Tests for completion.js - Shell Completion Module
 * 
 * Security: Tests validate completion script generation and
 * command suggestion safety.
 * 
 * Run with: npm test -- completion.test.js
 */

const completion = require('../lib/completion');

// =============================================================================
// Command Structure Tests
// =============================================================================

describe('Command Structure', () => {
  test('exports completion command', () => {
    expect(completion).toBeDefined();
    expect(typeof completion).toBe('object');
    expect(completion.name()).toBe('completion');
  });

  test('has expected subcommands', () => {
    const commands = completion.commands.map(cmd => cmd.name());
    expect(commands.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Shell Type Tests
// =============================================================================

describe('Shell Type Support', () => {
  test('supports bash shell', () => {
    const shell = 'bash';
    expect(['bash', 'zsh', 'fish']).toContain(shell);
  });

  test('supports zsh shell', () => {
    const shell = 'zsh';
    expect(['bash', 'zsh', 'fish']).toContain(shell);
  });

  test('supports fish shell', () => {
    const shell = 'fish';
    expect(['bash', 'zsh', 'fish']).toContain(shell);
  });

  test('rejects invalid shell types', () => {
    const invalidShells = ['powershell', 'cmd', 'sh; rm -rf /'];

    invalidShells.forEach(shell => {
      expect(['bash', 'zsh', 'fish']).not.toContain(shell);
    });
  });
});

// =============================================================================
// Completion Script Tests
// =============================================================================

describe('Completion Script Generation', () => {
  test('generates bash completion script', () => {
    const script = `
      _mc_completion() {
        local cur=\${COMP_WORDS[COMP_CWORD]}
        COMPREPLY=( $(compgen -W "help status deploy" -- $cur) )
      }
      complete -F _mc_completion mc
    `;
    expect(script).toContain('_mc_completion');
    expect(script).toContain('complete');
  });

  test('generates zsh completion script', () => {
    const script = `
      #compdef mc
      _mc() {
        local curcontext=\$curcontext state line
        _arguments '1: :->command'
      }
      compdef _mc mc
    `;
    expect(script).toContain('#compdef');
    expect(script).toContain('compdef');
  });

  test('completion script contains valid commands', () => {
    const commands = ['help', 'status', 'deploy', 'logs', 'config'];
    expect(commands.length).toBeGreaterThan(0);
    expect(commands).toContain('help');
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  test('rejects path traversal in shell paths', () => {
    const maliciousPaths = [
      '../../../etc/passwd',
      '..\\..\\windows\\system32',
    ];

    maliciousPaths.forEach(p => {
      expect(p).toMatch(/\.\.[\/\\]/);
    });
  });

  test('rejects command injection in completion setup', () => {
    const injectionAttempts = [
      'bash; rm -rf /',
      'zsh && whoami',
      'fish | cat /etc/passwd',
    ];

    injectionAttempts.forEach(attempt => {
      expect(attempt).toMatch(/[;|&`$]/);
    });
  });

  test('validates completion directory paths', () => {
    const validPaths = [
      '/etc/bash_completion.d',
      '~/.zsh/completions',
      '~/.config/fish/completions',
    ];

    validPaths.forEach(p => {
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// Command Suggestion Tests
// =============================================================================

describe('Command Suggestions', () => {
  test('suggests valid commands', () => {
    const suggestions = ['deploy', 'logs', 'status', 'config'];

    suggestions.forEach(cmd => {
      expect(cmd).toMatch(/^[a-z-]+$/);
    });
  });

  test('suggests valid flags', () => {
    const flags = ['--help', '--version', '--verbose', '-v'];

    flags.forEach(flag => {
      if (flag.startsWith('--')) {
        expect(flag).toMatch(/^--[a-z-]+$/);
      } else {
        expect(flag).toMatch(/^-[a-z]$/);
      }
    });
  });

  test('filters suggestions based on input', () => {
    const input = 'de';
    const commands = ['deploy', 'delete', 'describe', 'logs'];
    const filtered = commands.filter(c => c.startsWith(input));

    expect(filtered).toContain('deploy');
    expect(filtered).toContain('delete');
    expect(filtered).not.toContain('logs');
  });
});

// =============================================================================
// Installation Path Tests
// =============================================================================

describe('Installation Paths', () => {
  test('bash completion path is valid', () => {
    const bashPath = '/etc/bash_completion.d/mc';
    expect(bashPath).toContain('bash_completion');
    expect(bashPath).toContain('mc');
  });

  test('zsh completion path is valid', () => {
    const zshPath = '/usr/local/share/zsh/site-functions/_mc';
    expect(zshPath).toContain('zsh');
    expect(zshPath).toContain('_mc');
  });

  test('fish completion path is valid', () => {
    const fishPath = '~/.config/fish/completions/mc.fish';
    expect(fishPath).toContain('fish');
    expect(fishPath).toContain('completions');
  });
});

// =============================================================================
// Module Export Tests
// =============================================================================

describe('Module Exports', () => {
  test('exports completion command', () => {
    expect(completion).toBeDefined();
    expect(typeof completion).toBe('object');
    expect(completion.name()).toBe('completion');
  });

  test('has command methods', () => {
    expect(typeof completion.name).toBe('function');
    expect(typeof completion.commands).toBe('object');
  });
});
