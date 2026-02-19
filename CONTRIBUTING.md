# Contributing to MasterClaw Tools

Thank you for your interest in contributing to MasterClaw Tools! This document provides guidelines and best practices for contributing to the project.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Code Quality](#code-quality)
- [Security](#security)
- [Documentation](#documentation)
- [Submitting Changes](#submitting-changes)

## Getting Started

### Prerequisites

- Node.js 16.x or higher
- npm 8.x or higher
- Git

### Fork and Clone

```bash
# Fork the repository on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/masterclaw-tools.git
cd masterclaw-tools

# Install dependencies
npm install
```

## Development Setup

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- terraform.test.js

# Run tests with coverage
npm test -- --coverage

# Run tests in watch mode
npm test -- --watch
```

### Running Linting

```bash
# Check code quality
npm run lint

# Fix auto-fixable issues
npx eslint lib/ bin/ --fix
```

### Security Audit

```bash
# Check for vulnerabilities
npm audit

# Fix vulnerabilities (review changes carefully)
npm audit fix
```

## Making Changes

### Branch Naming

Use descriptive branch names:

```
feature/add-terraform-import
type/add-security-tests
docs/update-readme
fix/handle-null-options
```

### Commit Messages

Follow conventional commit format:

```
type(scope): description

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `test`: Adding or updating tests
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `security`: Security improvements
- `chore`: Build process or auxiliary tool changes

Examples:

```
feat(terraform): add import command for existing infrastructure

test(docker): add container security validation tests

docs(readme): update test coverage table

fix(template): handle null options gracefully

security(http-client): add DNS rebinding protection
```

## Testing

### Test Requirements

All new code must include comprehensive tests:

1. **Unit Tests**: Test individual functions in isolation
2. **Integration Tests**: Test module interactions
3. **Security Tests**: Test security validations and edge cases

### Test File Naming

Place tests in `tests/` directory with naming convention:

```
tests/<module>.test.js           # Standard test file
tests/<module>.security.test.js  # Security-focused tests
```

### Test Structure

```javascript
describe('Module Name', () => {
  describe('Function Name', () => {
    test('should do something specific', () => {
      // Arrange
      const input = 'test';
      
      // Act
      const result = functionUnderTest(input);
      
      // Assert
      expect(result).toBe(expected);
    });
    
    test('should handle error cases', () => {
      expect(() => functionUnderTest(null)).toThrow();
    });
  });
});
```

### Test Coverage Requirements

- Minimum 80% code coverage for new code
- 100% coverage for security-critical code
- All public functions must have tests
- All error paths must be tested

## Code Quality

### ESLint Rules

We use strict ESLint configuration. Key rules:

- **No unused variables**: Prefix with `_` if intentionally unused
- **No eval()**: Prevents code injection
- **Strict equality**: Use `===` and `!==`
- **Radix parameter**: Always provide radix to `parseInt()`

See [LINTING.md](./LINTING.md) for detailed guide.

### Code Style

- 2 spaces indentation
- Single quotes for strings
- Semicolons required
- Max line length: 120 characters
- Unix line endings (LF)

### Security Best Practices

1. **Input Validation**: Always validate user inputs
2. **Path Traversal**: Check for `../` and `..\` patterns
3. **Command Injection**: Sanitize shell command arguments
4. **Prototype Pollution**: Don't allow `__proto__`, `constructor`, `prototype` keys
5. **Regex**: Use safe regex patterns to prevent ReDoS

Example:

```javascript
// Validate inputs
function validateInput(input) {
  if (typeof input !== 'string') {
    throw new Error('Input must be a string');
  }
  
  // Check for path traversal
  if (input.includes('..')) {
    throw new SecurityError('Path traversal detected');
  }
  
  // Check for dangerous characters
  if (/[;|&`$]/.test(input)) {
    throw new SecurityError('Dangerous characters detected');
  }
  
  return input;
}
```

## Security

### Security Checklist

Before submitting:

- [ ] No hardcoded secrets or credentials
- [ ] All user inputs validated
- [ ] Path traversal protections in place
- [ ] Command injection mitigations
- [ ] Prototype pollution prevented
- [ ] Error messages don't leak sensitive info
- [ ] Dependencies audited (`npm audit`)

### Reporting Security Issues

Please report security vulnerabilities privately to the maintainers. See [SECURITY.md](./SECURITY.md) for details.

## Documentation

### Code Documentation

Use JSDoc for all public functions:

```javascript
/**
 * Validates container name to prevent command injection
 * @param {string} name - Container name to validate
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If name is invalid
 * @example
 * validateContainerName('mc-core'); // returns true
 * validateContainerName('../../../etc'); // throws
 */
function validateContainerName(name) {
  // implementation
}
```

### README Updates

When adding new features:

1. Update the command list
2. Add usage examples
3. Update test coverage table
4. Document any new environment variables

### CHANGELOG Updates

Add entries to [CHANGELOG.md](./CHANGELOG.md) under `[Unreleased]`:

```markdown
### Added
- New feature description

### Fixed
- Bug fix description

### Security
- Security fix description
```

## Submitting Changes

### Pull Request Process

1. **Create Branch**: `git checkout -b feature/your-feature`
2. **Make Changes**: Write code and tests
3. **Run Tests**: `npm test` (all must pass)
4. **Run Linting**: `npm run lint` (no errors)
5. **Update Docs**: README, CHANGELOG if needed
6. **Commit**: Follow commit message conventions
7. **Push**: `git push origin feature/your-feature`
8. **Create PR**: Fill out the PR template

### PR Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] All tests pass (`npm test`)
- [ ] New tests added for new functionality
- [ ] Security tests added for security changes

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex code
- [ ] Documentation updated
- [ ] No new warnings or errors
```

### Review Process

- All PRs require at least one review
- Address review comments promptly
- Re-request review after changes
- Squash commits before merge if requested

## Getting Help

- Check existing [issues](https://github.com/TheMasterClaw/masterclaw-tools/issues)
- Read the [documentation](./README.md)
- Ask in discussions

## Recognition

Contributors will be recognized in:
- CHANGELOG.md
- Git commit history
- Release notes

Thank you for contributing to MasterClaw Tools!
