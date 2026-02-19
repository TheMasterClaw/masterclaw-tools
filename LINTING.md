# Linting Guide for MasterClaw Tools

This document describes the ESLint configuration and how to maintain code quality in the MasterClaw Tools project.

## Overview

MasterClaw Tools uses ESLint for code quality and consistency. The configuration is security-focused and enforces best practices for Node.js CLI applications.

## Configuration

The ESLint configuration is defined in `.eslintrc.js` at the project root.

### Key Features

- **Security-focused rules**: Prevents `eval()`, unsafe globals, and prototype pollution
- **Error prevention**: Catches common JavaScript pitfalls before runtime
- **Code consistency**: Enforces uniform style across all contributors
- **Node.js optimized**: Tailored for CLI tool development

### Rule Categories

#### Error Prevention (Security & Stability)
- `no-eval` / `no-implied-eval` / `no-new-func` - Prevents code injection
- `handle-callback-err` - Ensures error handling in callbacks
- `no-throw-literal` - Requires Error objects for throwing
- `no-extend-native` - Prevents prototype pollution
- `no-caller` / `no-script-url` - Blocks deprecated/unsafe patterns

#### Code Quality
- `eqeqeq` - Requires strict equality (`===`)
- `consistent-return` - Ensures consistent return behavior
- `no-unused-vars` - Removes dead code (with `_` prefix exception)
- `no-use-before-define` - Prevents reference errors
- `radix` - Requires radix parameter for `parseInt()`

#### Style Consistency
- `indent: 2` - 2-space indentation
- `quotes: single` - Single quotes for strings
- `semi: always` - Required semicolons
- `max-len: 120` - 120 character line limit
- `linebreak-style: unix` - LF line endings

## Usage

### Run Linting

```bash
# Check all files
npm run lint

# Fix auto-fixable issues
npx eslint lib/ bin/ --fix

# Check specific file
npx eslint lib/security.js
```

### Pre-commit Workflow

```bash
# Before committing, run:
npm run lint

# Fix any auto-fixable issues:
npx eslint lib/ bin/ --fix

# Review remaining issues manually
```

## Common Issues and Fixes

### Unused Variables and Imports

**Problem:**
```javascript
const chalk = require('chalk');  // imported but never used
const path = require('path');     // imported but never used

function foo() {
  const unused = 'value';         // assigned but never used
  return 'bar';
}
```

**Fix:**
```javascript
// Remove unused imports
const { spawn } = require('child_process');

function foo() {
  return 'bar';
}
```

### Unnecessary Escape Characters

**Problem:**
```javascript
const pattern = new RegExp(`\\\`${cmd}\\b`);  // unnecessary escaping
```

**Fix:**
```javascript
const pattern = new RegExp(`\`${cmd}\\b`);   // correct escaping
```

### Unused Variables

**Problem:**
```javascript
const unused = require('./unused');
function foo(options) {  // options not used
  return 'bar';
}
```

**Fix:**
```javascript
// Prefix with underscore to indicate intentionally unused
function foo(_options) {
  return 'bar';
}

// Or remove if truly unnecessary
function foo() {
  return 'bar';
}
```

### Missing Radix in parseInt

**Problem:**
```javascript
const num = parseInt(input);
```

**Fix:**
```javascript
const num = parseInt(input, 10);
```

### Trailing Spaces

**Auto-fixable:**
```bash
npx eslint lib/ bin/ --fix
```

### Line Length

Keep lines under 120 characters. Break long strings with template literals:

```javascript
// Instead of:
const msg = 'This is a very long message that exceeds the 120 character limit for readability';

// Use:
const msg = 'This is a very long message that exceeds the 120 character ' +
            'limit for readability';
// Or:
const msg = `This is a very long message that exceeds the 120 character
limit for readability`;
```

## CI/CD Integration

The GitHub Actions workflow runs ESLint on every push and pull request:

```yaml
- name: Run ESLint
  run: npm run lint
```

Currently configured to report issues without failing the build (see `.github/workflows/test-masterclaw-tools.yml`).

## IDE Integration

### VS Code

Install the ESLint extension for real-time feedback:

1. Install "ESLint" extension by Microsoft
2. The extension will automatically use `.eslintrc.js`

### Vim/Neovim

Using ALE or coc-eslint:

```vim
" ALE configuration
let g:ale_linters = {
\   'javascript': ['eslint'],
\}
```

## File-specific Overrides

Some files have specific rule overrides:

- **Tests** (`tests/**/*.js`): Relaxed line length rules
- **Security files** (`lib/security.js`, `lib/chat-security.js`): Allow control characters in regex for sanitization

## Migration Guide

When introducing new rules to an existing codebase:

1. Add rule to `.eslintrc.js`
2. Run `npx eslint lib/ bin/ --fix` to auto-fix
3. Manually fix remaining issues
4. Update this documentation

## Security Considerations

The linting configuration specifically targets security issues:

- **No eval()**: Prevents code injection attacks
- **No extending native prototypes**: Prevents prototype pollution
- **Error handling required**: Ensures proper error management
- **Strict equality**: Prevents type coercion bugs

## Contributing

When contributing code:

1. Ensure your code passes `npm run lint`
2. Use `npx eslint --fix` to auto-fix style issues
3. Document any intentional rule disabling with comments

## Resources

- [ESLint Rules](https://eslint.org/docs/rules/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [MasterClaw Security Module](./lib/security.js)
