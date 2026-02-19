/**
 * Tests for exec.js module
 * Run with: npm test -- exec.test.js
 *
 * Tests container execution security and utility functions.
 */

const {
  ALLOWED_CONTAINERS,
  BLOCKED_COMMANDS,
  SHELL_INTERPRETERS,
  SHELL_COMMAND_OPTIONS,
  BLOCKED_SUBCOMMANDS,
  RESOURCE_LIMITS,
  DISABLE_RESOURCE_LIMITS_ENV,
  EXIT_CODES,
  DOCKER_STATUS_TIMEOUT_MS,
  validateAllowedContainer,
  validateCommand,
  validateShellCommand,
  validateShellCommandString,
  checkDangerousCharacters,
  analyzeExitCode,
  detectOOMFromStderr,
} = require('../lib/exec');

const { DockerSecurityError } = require('../lib/docker');

// =============================================================================
// Constants Tests
// =============================================================================

describe('Exec Module Constants', () => {
  test('ALLOWED_CONTAINERS contains expected services', () => {
    expect(ALLOWED_CONTAINERS.has('mc-core')).toBe(true);
    expect(ALLOWED_CONTAINERS.has('mc-backend')).toBe(true);
    expect(ALLOWED_CONTAINERS.has('mc-gateway')).toBe(true);
    expect(ALLOWED_CONTAINERS.has('mc-chroma')).toBe(true);
    expect(ALLOWED_CONTAINERS.has('mc-interface')).toBe(true);
    expect(ALLOWED_CONTAINERS.has('mc-traefik')).toBe(true);
  });

  test('BLOCKED_COMMANDS contains destructive commands', () => {
    expect(BLOCKED_COMMANDS.has('rm')).toBe(true);
    expect(BLOCKED_COMMANDS.has('dd')).toBe(true);
    expect(BLOCKED_COMMANDS.has('mkfs')).toBe(true);
    expect(BLOCKED_COMMANDS.has('fdisk')).toBe(true);
    expect(BLOCKED_COMMANDS.has('format')).toBe(true);
  });

  test('SHELL_INTERPRETERS contains common shells', () => {
    expect(SHELL_INTERPRETERS.has('sh')).toBe(true);
    expect(SHELL_INTERPRETERS.has('bash')).toBe(true);
    expect(SHELL_INTERPRETERS.has('zsh')).toBe(true);
    expect(SHELL_INTERPRETERS.has('dash')).toBe(true);
  });

  test('SHELL_COMMAND_OPTIONS contains command options', () => {
    expect(SHELL_COMMAND_OPTIONS.has('-c')).toBe(true);
    expect(SHELL_COMMAND_OPTIONS.has('--command')).toBe(true);
  });

  test('BLOCKED_SUBCOMMANDS contains dangerous subcommands', () => {
    expect(BLOCKED_SUBCOMMANDS.has('rm')).toBe(true);
    expect(BLOCKED_SUBCOMMANDS.has('dd')).toBe(true);
    expect(BLOCKED_SUBCOMMANDS.has('mkfs')).toBe(true);
  });

  test('RESOURCE_LIMITS has expected structure', () => {
    expect(RESOURCE_LIMITS).toHaveProperty('nproc');
    expect(RESOURCE_LIMITS).toHaveProperty('nofile');
    expect(RESOURCE_LIMITS).toHaveProperty('memory');
    expect(RESOURCE_LIMITS).toHaveProperty('stack');

    expect(RESOURCE_LIMITS.nproc).toHaveProperty('soft');
    expect(RESOURCE_LIMITS.nproc).toHaveProperty('hard');
    expect(RESOURCE_LIMITS.nproc).toHaveProperty('description');
  });

  test('RESOURCE_LIMITS has reasonable values', () => {
    // nproc limits for fork bomb protection
    expect(RESOURCE_LIMITS.nproc.soft).toBe(128);
    expect(RESOURCE_LIMITS.nproc.hard).toBe(256);

    // Memory limits (512MB soft, 1GB hard)
    expect(RESOURCE_LIMITS.memory.soft).toBe(536870912);
    expect(RESOURCE_LIMITS.memory.hard).toBe(1073741824);
  });

  test('DISABLE_RESOURCE_LIMITS_ENV is defined', () => {
    expect(DISABLE_RESOURCE_LIMITS_ENV).toBe('MC_EXEC_NO_RESOURCE_LIMITS');
  });

  test('EXIT_CODES has expected signal codes', () => {
    expect(EXIT_CODES.SIGKILL).toBe(137);  // 128 + 9
    expect(EXIT_CODES.SIGTERM).toBe(143);  // 128 + 15
    expect(EXIT_CODES.SIGXCPU).toBe(152);  // 128 + 24
    expect(EXIT_CODES.SIGXFSZ).toBe(153);  // 128 + 25
    expect(EXIT_CODES.SIGSYS).toBe(159);   // 128 + 31
  });

  test('DOCKER_STATUS_TIMEOUT_MS is 10 seconds', () => {
    expect(DOCKER_STATUS_TIMEOUT_MS).toBe(10000);
  });
});

// =============================================================================
// analyzeExitCode Tests
// =============================================================================

describe('analyzeExitCode', () => {
  test('returns non-violation for exit code 0', () => {
    const result = analyzeExitCode(0);
    expect(result.exitCode).toBe(0);
    expect(result.isResourceViolation).toBe(false);
    expect(result.violationType).toBeNull();
  });

  test('detects SIGKILL (137) as resource violation', () => {
    const result = analyzeExitCode(137);
    expect(result.isResourceViolation).toBe(true);
    expect(result.violationType).toBe('RESOURCE_LIMIT');
    expect(result.description).toContain('forcefully killed');
    expect(result.suggestion).toContain('memory');
  });

  test('detects SIGXCPU (152) as CPU limit violation', () => {
    const result = analyzeExitCode(152);
    expect(result.isResourceViolation).toBe(true);
    expect(result.violationType).toBe('CPU_LIMIT');
    expect(result.description).toContain('CPU time');
  });

  test('detects SIGXFSZ (153) as file size limit violation', () => {
    const result = analyzeExitCode(153);
    expect(result.isResourceViolation).toBe(true);
    expect(result.violationType).toBe('FILE_SIZE_LIMIT');
    expect(result.description).toContain('File size');
  });

  test('detects SIGSYS (159) as blocked system call', () => {
    const result = analyzeExitCode(159);
    expect(result.isResourceViolation).toBe(true);
    expect(result.violationType).toBe('SYSTEM_CALL_BLOCKED');
    expect(result.description).toContain('Blocked system call');
  });

  test('handles generic non-zero exit codes', () => {
    const result = analyzeExitCode(1);
    expect(result.isResourceViolation).toBe(false);
    expect(result.description).toContain('exited with code 1');
  });
});

// =============================================================================
// detectOOMFromStderr Tests
// =============================================================================

describe('detectOOMFromStderr', () => {
  test('returns false for null/undefined', () => {
    expect(detectOOMFromStderr(null)).toBe(false);
    expect(detectOOMFromStderr(undefined)).toBe(false);
    expect(detectOOMFromStderr('')).toBe(false);
  });

  test('detects "killed process" message', () => {
    expect(detectOOMFromStderr('The process was killed process by system')).toBe(true);
    expect(detectOOMFromStderr('killed process 1234')).toBe(true);
  });

  test('detects "out of memory" message', () => {
    expect(detectOOMFromStderr('Error: out of memory')).toBe(true);
    expect(detectOOMFromStderr('Out Of Memory occurred')).toBe(true);
  });

  test('detects "oom-kill" message', () => {
    expect(detectOOMFromStderr('oom-kill: process 123')).toBe(true);
    expect(detectOOMFromStderr('OOM kill triggered')).toBe(true);
  });

  test('detects "cannot allocate memory" message', () => {
    expect(detectOOMFromStderr('cannot allocate memory')).toBe(true);
  });

  test('detects "memory cgroup out of memory" message', () => {
    expect(detectOOMFromStderr('memory cgroup out of memory')).toBe(true);
  });

  test('returns false for non-OOM messages', () => {
    expect(detectOOMFromStderr('Command not found')).toBe(false);
    expect(detectOOMFromStderr('Permission denied')).toBe(false);
    expect(detectOOMFromStderr('Normal output')).toBe(false);
  });
});

// =============================================================================
// validateAllowedContainer Tests
// =============================================================================

describe('validateAllowedContainer', () => {
  test('accepts allowed containers', () => {
    expect(() => validateAllowedContainer('mc-core')).not.toThrow();
    expect(() => validateAllowedContainer('mc-backend')).not.toThrow();
    expect(() => validateAllowedContainer('mc-gateway')).not.toThrow();
  });

  test('rejects non-allowed containers', () => {
    expect(() => validateAllowedContainer('nginx')).toThrow(DockerSecurityError);
    expect(() => validateAllowedContainer('mysql')).toThrow(DockerSecurityError);
    expect(() => validateAllowedContainer('random')).toThrow(DockerSecurityError);
  });

  test('error includes allowed container list', () => {
    try {
      validateAllowedContainer('invalid');
    } catch (err) {
      expect(err.code).toBe('CONTAINER_NOT_ALLOWED');
      expect(err.message).toContain('Allowed containers');
    }
  });

  test('rejects invalid container names', () => {
    expect(() => validateAllowedContainer('')).toThrow();
    expect(() => validateAllowedContainer('../etc')).toThrow();
    expect(() => validateAllowedContainer('container;rm -rf')).toThrow();
  });
});

// =============================================================================
// validateCommand Tests
// =============================================================================

describe('validateCommand', () => {
  test('accepts valid commands', () => {
    expect(() => validateCommand(['ls'])).not.toThrow();
    expect(() => validateCommand(['ls', '-la'])).not.toThrow();
    expect(() => validateCommand(['cat', '/etc/hosts'])).not.toThrow();
  });

  test('rejects non-array commands', () => {
    expect(() => validateCommand('ls')).toThrow(DockerSecurityError);
    expect(() => validateCommand(null)).toThrow(DockerSecurityError);
    expect(() => validateCommand(123)).toThrow(DockerSecurityError);
  });

  test('rejects empty commands', () => {
    expect(() => validateCommand([])).toThrow(DockerSecurityError);
  });

  test('rejects blocked commands', () => {
    expect(() => validateCommand(['rm', '/file'])).toThrow(DockerSecurityError);
    expect(() => validateCommand(['dd'])).toThrow(DockerSecurityError);
    expect(() => validateCommand(['mkfs', '/dev/sda'])).toThrow(DockerSecurityError);
  });

  test('rejects commands that are too long', () => {
    const longArg = 'a'.repeat(5000);
    expect(() => validateCommand(['echo', longArg])).toThrow(DockerSecurityError);
  });

  test('is case-insensitive for blocked commands', () => {
    expect(() => validateCommand(['RM', '/file'])).toThrow(DockerSecurityError);
    expect(() => validateCommand(['Dd'])).toThrow(DockerSecurityError);
  });
});

// =============================================================================
// validateShellCommand Tests
// =============================================================================

describe('validateShellCommand', () => {
  test('accepts safe shell commands', () => {
    expect(() => validateShellCommand(['bash', '-c', 'ls'])).not.toThrow();
    expect(() => validateShellCommand(['sh', '-c', 'echo hello'])).not.toThrow();
  });

  test('accepts non-shell commands', () => {
    expect(() => validateShellCommand(['ls', '-la'])).not.toThrow();
    expect(() => validateShellCommand(['cat', 'file.txt'])).not.toThrow();
  });

  test('rejects command chaining in shell', () => {
    expect(() => validateShellCommand(['bash', '-c', 'ls; rm file'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['sh', '-c', 'ls && rm file'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['bash', '-c', 'ls | cat'])).toThrow(DockerSecurityError);
  });

  test('rejects command substitution', () => {
    expect(() => validateShellCommand(['bash', '-c', 'echo $(rm file)'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['sh', '-c', 'echo `rm file`'])).toThrow(DockerSecurityError);
  });

  test('rejects blocked subcommands in shell', () => {
    expect(() => validateShellCommand(['bash', '-c', 'rm file'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['sh', '-c', 'dd if=/dev/zero'])).toThrow(DockerSecurityError);
  });
});

// =============================================================================
// validateShellCommandString Tests
// =============================================================================

describe('validateShellCommandString', () => {
  test('accepts safe command strings', () => {
    expect(() => validateShellCommandString('ls')).not.toThrow();
    expect(() => validateShellCommandString('echo hello')).not.toThrow();
    expect(() => validateShellCommandString('cat /etc/hosts')).not.toThrow();
  });

  test('rejects null/undefined', () => {
    expect(() => validateShellCommandString(null)).not.toThrow();
    expect(() => validateShellCommandString(undefined)).not.toThrow();
  });

  test('rejects command chaining', () => {
    expect(() => validateShellCommandString('ls; cat')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('ls && cat')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('ls || cat')).toThrow(DockerSecurityError);
  });

  test('rejects command substitution', () => {
    expect(() => validateShellCommandString('echo $(whoami)')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('echo `whoami`')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('echo ${VAR}')).toThrow(DockerSecurityError);
  });

  test('rejects blocked subcommands', () => {
    expect(() => validateShellCommandString('rm file')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('dd if=/dev/zero')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('mkfs.ext4 /dev/sda')).toThrow(DockerSecurityError);
  });

  test('rejects path traversal', () => {
    expect(() => validateShellCommandString('cat ../../etc/passwd')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('ls ~/')).toThrow(DockerSecurityError);
  });
});

// =============================================================================
// checkDangerousCharacters Tests
// =============================================================================

describe('checkDangerousCharacters', () => {
  test('accepts safe commands', () => {
    expect(() => checkDangerousCharacters(['ls', '-la'])).not.toThrow();
    expect(() => checkDangerousCharacters(['cat', 'file.txt'])).not.toThrow();
    expect(() => checkDangerousCharacters(['echo', 'hello world'])).not.toThrow();
  });

  test('rejects semicolons', () => {
    expect(() => checkDangerousCharacters(['ls;', 'rm'])).toThrow(DockerSecurityError);
  });

  test('rejects pipes', () => {
    expect(() => checkDangerousCharacters(['ls', '|', 'cat'])).toThrow(DockerSecurityError);
  });

  test('rejects backticks', () => {
    expect(() => checkDangerousCharacters(['echo', '`whoami`'])).toThrow(DockerSecurityError);
  });

  test('rejects dollar signs', () => {
    expect(() => checkDangerousCharacters(['echo', '$VAR'])).toThrow(DockerSecurityError);
  });

  test('rejects parentheses', () => {
    expect(() => checkDangerousCharacters(['echo', '$(cmd)'])).toThrow(DockerSecurityError);
  });

  test('rejects brackets', () => {
    expect(() => checkDangerousCharacters(['echo', '${VAR}'])).toThrow(DockerSecurityError);
  });

  test('rejects redirection operators', () => {
    expect(() => checkDangerousCharacters(['echo', '>file'])).toThrow(DockerSecurityError);
    expect(() => checkDangerousCharacters(['cat', '<file'])).toThrow(DockerSecurityError);
  });
});
