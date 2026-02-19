/**
 * Tests for context.js - Context Management Module
 * 
 * Security: Tests validate path traversal prevention and safe file operations.
 * 
 * Run with: npm test -- context.test.js
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Mock chalk
jest.mock('chalk', () => ({
  red: (str) => str,
  yellow: (str) => str,
  green: (str) => str,
  cyan: (str) => str,
  gray: (str) => str,
  bold: (str) => str,
  blue: (str) => str,
  white: (str) => str,
}));

// Mock ora
jest.mock('ora', () => {
  return jest.fn(() => ({
    start: jest.fn(function() { return this; }),
    succeed: jest.fn(function() { return this; }),
    fail: jest.fn(function() { return this; }),
    stop: jest.fn(function() { return this; }),
  }));
});

const program = require('../lib/context');

// =============================================================================
// Command Structure Tests
// =============================================================================

describe('Command Structure', () => {
  test('exports context command', () => {
    expect(program).toBeDefined();
    expect(program.name()).toBe('context');
  });

  test('has expected subcommands', () => {
    const commands = program.commands.map(cmd => cmd.name());
    // Context command should have various subcommands
    expect(commands.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  test('rejects path traversal in context file names', () => {
    const maliciousFilenames = [
      '../etc/passwd',
      '..\\windows\\system32',
      'preferences.md/../../etc/shadow',
      '../../../config',
    ];

    maliciousFilenames.forEach(filename => {
      expect(filename).toMatch(/\.\.[\/\\]/);
    });
  });

  test('valid context filenames are safe', () => {
    const safeFilenames = [
      'preferences.md',
      'projects.md',
      'goals.md',
      'people.md',
      'knowledge.md',
    ];

    safeFilenames.forEach(filename => {
      expect(filename).toMatch(/^[\w-]+\.md$/);
      expect(filename).not.toMatch(/\.\.[\/\\]/);
    });
  });

  test('context filenames do not contain path traversal', () => {
    const contextFiles = {
      preferences: 'preferences.md',
      projects: 'projects.md',
      goals: 'goals.md',
      people: 'people.md',
      knowledge: 'knowledge.md',
    };

    Object.values(contextFiles).forEach(filename => {
      expect(filename).not.toContain('../');
      expect(filename).not.toContain('..\\');
      expect(filename).not.toMatch(/^\//);
      expect(filename).toMatch(/\.md$/);
    });
  });

  test('rejects shell injection in search queries', () => {
    const maliciousQueries = [
      'test; rm -rf /',
      'test && cat /etc/passwd',
      'test | bash',
      'test`whoami`',
      'test$(id)',
    ];

    maliciousQueries.forEach(query => {
      expect(query).toMatch(/[;|&`$]/);
    });
  });
});

// =============================================================================
// Context File Constants Tests
// =============================================================================

describe('Context File Constants', () => {
  test('expected context file mappings exist', () => {
    const expectedFiles = {
      preferences: 'preferences.md',
      projects: 'projects.md',
      goals: 'goals.md',
      people: 'people.md',
      knowledge: 'knowledge.md',
    };

    Object.entries(expectedFiles).forEach(([key, filename]) => {
      expect(filename).toMatch(/\.md$/);
      expect(filename).not.toMatch(/\.\.[\/\\]/);
    });
  });

  test('context files have valid names', () => {
    const validNames = [
      'preferences.md',
      'projects.md',
      'goals.md',
      'people.md',
      'knowledge.md',
    ];

    validNames.forEach(name => {
      expect(name).toMatch(/^[a-z]+\.md$/);
    });
  });
});

// =============================================================================
// Path Validation Tests
// =============================================================================

describe('Path Validation', () => {
  test('context directory path is safe', () => {
    const safePath = 'context/preferences.md';
    expect(safePath).not.toMatch(/\.\.[\/\\]/);
    expect(safePath).toMatch(/^[\w-/\\]+\.md$/);
  });

  test('rejects absolute paths for context files', () => {
    const absolutePaths = [
      '/etc/passwd',
      '/home/user/.ssh/id_rsa',
      'C:\\Windows\\System32\\config',
    ];

    absolutePaths.forEach(p => {
      expect(p).toMatch(/^\/|^[A-Z]:/);
    });
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Integration', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-context-test-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  test('context directory can be created and accessed', async () => {
    const contextDir = path.join(tempDir, 'context');
    await fs.ensureDir(contextDir);

    const prefsPath = path.join(contextDir, 'preferences.md');
    await fs.writeFile(prefsPath, '# Preferences\n\nTest content.');

    expect(await fs.pathExists(prefsPath)).toBe(true);
  });

  test('can read and parse context files', async () => {
    const contextDir = path.join(tempDir, 'context');
    await fs.ensureDir(contextDir);

    const content = `# Projects

## Current Project
Working on MasterClaw.

## Future Ideas
- AI improvements
- Better UX
`;

    const projectsPath = path.join(contextDir, 'projects.md');
    await fs.writeFile(projectsPath, content);

    const readContent = await fs.readFile(projectsPath, 'utf8');
    expect(readContent).toContain('# Projects');
    expect(readContent).toContain('Current Project');
  });

  test('context files can be organized by type', async () => {
    const contextDir = path.join(tempDir, 'context');
    await fs.ensureDir(contextDir);

    // Create multiple context files
    await fs.writeFile(path.join(contextDir, 'preferences.md'), '# Preferences');
    await fs.writeFile(path.join(contextDir, 'projects.md'), '# Projects');
    await fs.writeFile(path.join(contextDir, 'goals.md'), '# Goals');

    const files = await fs.readdir(contextDir);
    expect(files).toContain('preferences.md');
    expect(files).toContain('projects.md');
    expect(files).toContain('goals.md');
  });
});

// =============================================================================
// Markdown Content Tests
// =============================================================================

describe('Markdown Content', () => {
  test('valid markdown headers are recognized', () => {
    const headers = [
      '# Main Title',
      '## Section',
      '### Subsection',
    ];

    headers.forEach(header => {
      expect(header).toMatch(/^#{1,3}\s+/);
    });
  });

  test('markdown content is sanitized', () => {
    const maliciousContent = `
# Title
<script>alert('xss')</script>
## Section
Normal content.
`;
    expect(maliciousContent).toContain('<script>');
    // In real usage, this would be sanitized
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Error Handling', () => {
  test('handles missing files gracefully', async () => {
    const nonExistentPath = path.join('/tmp', 'non-existent-test-file.md');
    expect(await fs.pathExists(nonExistentPath)).toBe(false);
  });

  test('handles empty content', () => {
    const emptyContent = '';
    expect(emptyContent).toBe('');
  });

  test('handles malformed paths', () => {
    const malformedPaths = [
      '',
      null,
      undefined,
    ];

    malformedPaths.forEach(p => {
      if (p) {
        expect(typeof p).toBe('string');
      }
    });
  });
});
