/**
 * Tests for troubleshoot.js module
 * Run with: npm test -- troubleshoot.test.js
 *
 * Tests troubleshooting guide functionality.
 */

const {
  ISSUES,
  getIssuesByCategory,
  getAllCategories,
  formatSeverity,
} = require('../lib/troubleshoot');

// =============================================================================
// ISSUES Database Tests
// =============================================================================

describe('Troubleshoot Module', () => {
  describe('ISSUES Database', () => {
    test('contains expected issues', () => {
      expect(ISSUES).toHaveProperty('services-down');
      expect(ISSUES).toHaveProperty('ssl-cert-issues');
      expect(ISSUES).toHaveProperty('high-memory-usage');
      expect(ISSUES).toHaveProperty('database-issues');
      expect(ISSUES).toHaveProperty('llm-api-errors');
      expect(ISSUES).toHaveProperty('backup-failures');
      expect(ISSUES).toHaveProperty('slow-performance');
      expect(ISSUES).toHaveProperty('notification-issues');
    });

    test('each issue has required fields', () => {
      for (const [key, issue] of Object.entries(ISSUES)) {
        expect(issue).toHaveProperty('title');
        expect(issue).toHaveProperty('symptoms');
        expect(issue).toHaveProperty('severity');
        expect(issue).toHaveProperty('category');
        expect(issue).toHaveProperty('diagnosis');
        expect(issue).toHaveProperty('solutions');
        expect(issue).toHaveProperty('prevention');

        expect(typeof issue.title).toBe('string');
        expect(Array.isArray(issue.symptoms)).toBe(true);
        expect(Array.isArray(issue.diagnosis)).toBe(true);
        expect(Array.isArray(issue.solutions)).toBe(true);
        expect(Array.isArray(issue.prevention)).toBe(true);
      }
    });

    test('severities are valid', () => {
      const validSeverities = ['critical', 'high', 'medium', 'low'];
      for (const issue of Object.values(ISSUES)) {
        expect(validSeverities).toContain(issue.severity);
      }
    });

    test('categories are valid', () => {
      const validCategories = ['docker', 'ssl', 'performance', 'database', 'api', 'backup', 'notifications'];
      for (const issue of Object.values(ISSUES)) {
        expect(validCategories).toContain(issue.category);
      }
    });

    test('solutions have required fields', () => {
      for (const issue of Object.values(ISSUES)) {
        for (const solution of issue.solutions) {
          expect(solution).toHaveProperty('title');
          expect(solution).toHaveProperty('command');
          expect(solution).toHaveProperty('description');
          expect(typeof solution.title).toBe('string');
          expect(typeof solution.command).toBe('string');
          expect(typeof solution.description).toBe('string');
        }
      }
    });

    test('services-down issue has correct structure', () => {
      const issue = ISSUES['services-down'];
      expect(issue.title).toBe('Services Not Starting');
      expect(issue.severity).toBe('critical');
      expect(issue.category).toBe('docker');
      expect(issue.symptoms).toContain('Docker containers keep restarting');
      expect(issue.symptoms).toContain('mc status shows services as down');
    });

    test('ssl-cert-issues has SSL-related solutions', () => {
      const issue = ISSUES['ssl-cert-issues'];
      expect(issue.category).toBe('ssl');
      
      const solutionCommands = issue.solutions.map(s => s.command);
      expect(solutionCommands.some(cmd => cmd.includes('ssl'))).toBe(true);
    });

    test('database-issues has database-related diagnosis', () => {
      const issue = ISSUES['database-issues'];
      expect(issue.category).toBe('database');
      
      const diagnosisText = issue.diagnosis.join(' ');
      expect(diagnosisText).toContain('ChromaDB');
    });

    test('high-memory-usage has memory-related solutions', () => {
      const issue = ISSUES['high-memory-usage'];
      expect(issue.category).toBe('performance');
      
      const solutionText = issue.solutions.map(s => s.command).join(' ');
      expect(solutionText).toContain('restart');
    });

    test('llm-api-errors has API-related diagnosis', () => {
      const issue = ISSUES['llm-api-errors'];
      expect(issue.category).toBe('api');
      
      const diagnosisText = issue.diagnosis.join(' ');
      expect(diagnosisText).toContain('API key');
    });

    test('backup-failures has backup-related solutions', () => {
      const issue = ISSUES['backup-failures'];
      expect(issue.category).toBe('backup');
      
      const solutionCommands = issue.solutions.map(s => s.command);
      expect(solutionCommands.some(cmd => cmd.includes('backup'))).toBe(true);
    });

    test('slow-performance has performance-related diagnosis', () => {
      const issue = ISSUES['slow-performance'];
      expect(issue.category).toBe('performance');
      
      const diagnosisText = issue.diagnosis.join(' ');
      expect(diagnosisText).toContain('performance');
    });

    test('notification-issues has notification-related solutions', () => {
      const issue = ISSUES['notification-issues'];
      expect(issue.category).toBe('notifications');
      
      const solutionCommands = issue.solutions.map(s => s.command);
      expect(solutionCommands.some(cmd => cmd.includes('notify'))).toBe(true);
    });
  });

  // ===========================================================================
  // getIssuesByCategory Tests
  // ===========================================================================
  describe('getIssuesByCategory', () => {
    test('returns issues for valid category', () => {
      const dockerIssues = getIssuesByCategory('docker');
      expect(dockerIssues.length).toBeGreaterThan(0);
      expect(dockerIssues.every(i => i.category === 'docker')).toBe(true);
    });

    test('returns empty array for category with no issues', () => {
      const issues = getIssuesByCategory('nonexistent');
      expect(issues).toEqual([]);
    });

    test('returned issues have key property', () => {
      const issues = getIssuesByCategory('performance');
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]).toHaveProperty('key');
      expect(issues[0]).toHaveProperty('title');
    });

    test('performance category has expected issues', () => {
      const issues = getIssuesByCategory('performance');
      const issueKeys = issues.map(i => i.key);
      expect(issueKeys).toContain('high-memory-usage');
      expect(issueKeys).toContain('slow-performance');
    });
  });

  // ===========================================================================
  // getAllCategories Tests
  // ===========================================================================
  describe('getAllCategories', () => {
    test('returns array of categories', () => {
      const categories = getAllCategories();
      expect(Array.isArray(categories)).toBe(true);
      expect(categories.length).toBeGreaterThan(0);
    });

    test('returns unique categories', () => {
      const categories = getAllCategories();
      const uniqueCategories = [...new Set(categories)];
      expect(categories.length).toBe(uniqueCategories.length);
    });

    test('includes expected categories', () => {
      const categories = getAllCategories();
      expect(categories).toContain('docker');
      expect(categories).toContain('ssl');
      expect(categories).toContain('performance');
      expect(categories).toContain('database');
    });

    test('does not include duplicates', () => {
      const categories = getAllCategories();
      const categoryCounts = {};
      categories.forEach(c => {
        categoryCounts[c] = (categoryCounts[c] || 0) + 1;
      });
      
      Object.values(categoryCounts).forEach(count => {
        expect(count).toBe(1);
      });
    });
  });

  // ===========================================================================
  // formatSeverity Tests
  // ===========================================================================
  describe('formatSeverity', () => {
    test('returns formatted string for critical', () => {
      const result = formatSeverity('critical');
      expect(typeof result).toBe('string');
    });

    test('returns formatted string for high', () => {
      const result = formatSeverity('high');
      expect(typeof result).toBe('string');
    });

    test('returns formatted string for medium', () => {
      const result = formatSeverity('medium');
      expect(typeof result).toBe('string');
    });

    test('returns formatted string for low', () => {
      const result = formatSeverity('low');
      expect(typeof result).toBe('string');
    });

    test('handles unknown severity gracefully', () => {
      const result = formatSeverity('unknown');
      expect(result).toBe('unknown');
    });
  });
});
