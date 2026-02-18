/**
 * ESLint Configuration for MasterClaw Tools
 * 
 * Security-focused linting configuration that enforces:
 * - Code quality and consistency
 * - Security best practices for Node.js/CLI applications
 * - Error prevention and bug detection
 * 
 * @see https://eslint.org/docs/user-guide/configuring
 */

module.exports = {
  root: true,
  
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  
  extends: [
    'eslint:recommended',
  ],
  
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
  
  rules: {
    // =========================================================================
    // Error Prevention (Security & Stability)
    // =========================================================================
    
    // Prevent accidental use of eval() and similar
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    
    // Note: process and Buffer are essential Node.js globals for CLI tools
    // We allow them but restrict dangerous methods through other rules
    
    // Ensure error handling in callbacks
    'handle-callback-err': ['error', '^(err|error)$'],
    
    // Prevent using variables before definition
    'no-use-before-define': ['error', { functions: false, classes: false }],
    
    // Disallow throwing literals (always throw Error objects)
    'no-throw-literal': 'error',
    
    // Ensure return statements in callbacks
    'callback-return': ['warn', ['callback', 'cb', 'next', 'done']],
    
    // =========================================================================
    // Security Best Practices
    // =========================================================================
    
    // Disallow use of __proto__ (prototype pollution risk)
    'no-proto': 'error',
    
    // Disallow use of Object.prototype builtins directly
    'no-extend-native': 'error',
    
    // Prevent reassigning function parameters (helps prevent injection)
    'no-param-reassign': ['warn', { props: false }],
    
    // Disallow returning values from constructor functions
    'no-constructor-return': 'error',
    
    // Disallow use of caller/callee (deprecated, security concerns)
    'no-caller': 'error',
    
    // Disallow eval()-like methods
    'no-script-url': 'error',
    
    // =========================================================================
    // Code Quality & Maintainability
    // =========================================================================
    
    // Consistent return behavior
    'consistent-return': 'error',
    
    // Require strict equality (=== and !==)
    'eqeqeq': ['error', 'always', { null: 'ignore' }],
    
    // No unreachable code
    'no-unreachable': 'error',
    
    // No unused variables (except function args with underscore prefix)
    'no-unused-vars': ['error', { 
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    }],
    
    // No redeclaring variables
    'no-redeclare': 'error',
    
    // Prefer const/let over var
    'no-var': 'warn',
    'prefer-const': ['warn', { ignoreReadBeforeAssign: true }],
    
    // =========================================================================
    // Style Consistency (Readable, Professional Code)
    // =========================================================================
    
    // Indentation: 2 spaces
    'indent': ['error', 2, { 
      SwitchCase: 1,
      VariableDeclarator: 1,
      outerIIFEBody: 1,
      MemberExpression: 1,
      FunctionDeclaration: { parameters: 1, body: 1 },
      FunctionExpression: { parameters: 1, body: 1 },
      CallExpression: { arguments: 1 },
      ArrayExpression: 1,
      ObjectExpression: 1,
      ImportDeclaration: 1,
      flatTernaryExpressions: false,
      offsetTernaryExpressions: true,
    }],
    
    // Line endings: Unix-style (LF)
    'linebreak-style': ['error', 'unix'],
    
    // Quotes: single quotes
    'quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    
    // Semicolons: required
    'semi': ['error', 'always'],
    
    // No trailing spaces
    'no-trailing-spaces': 'error',
    
    // Consistent spacing before/after keywords
    'keyword-spacing': ['error', { before: true, after: true }],
    
    // Consistent spacing before blocks
    'space-before-blocks': ['error', 'always'],
    
    // Spacing in function parentheses
    'space-before-function-paren': ['error', {
      anonymous: 'always',
      named: 'never',
      asyncArrow: 'always',
    }],
    
    // No space before function call parentheses
    'func-call-spacing': ['error', 'never'],
    
    // Object curly spacing: { key: value }
    'object-curly-spacing': ['error', 'always'],
    
    // Array bracket spacing: [1, 2, 3]
    'array-bracket-spacing': ['error', 'never'],
    
    // Brace style: 1tbs (one true brace style)
    'brace-style': ['error', '1tbs', { allowSingleLine: true }],
    
    // Max line length
    'max-len': ['warn', { 
      code: 120, 
      ignoreUrls: true, 
      ignoreStrings: true, 
      ignoreTemplateLiterals: true,
      ignoreComments: true,
    }],
    
    // No multiple empty lines
    'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 1 }],
    
    // EOL at end of file
    'eol-last': ['error', 'always'],
    
    // =========================================================================
    // Best Practices for CLI Tools
    // =========================================================================
    
    // Require error handling in try-catch
    'no-empty': ['error', { allowEmptyCatch: false }],
    
    // No console in production code (warn - some CLI output is intentional)
    'no-console': 'off',
    
    // Prefer template literals for string concatenation
    'prefer-template': 'warn',
    
    // Disallow Yoda conditions (if (1 === x))
    'yoda': ['error', 'never'],
    
    // Require radix parameter for parseInt()
    'radix': 'error',
    
    // Require default case in switch statements
    'default-case': 'warn',
    
    // No floating decimals (.5 instead of 0.5)
    'no-floating-decimal': 'error',
    
    // No implicit string/number conversion
    'no-implicit-coercion': ['warn', { allow: ['!!', '+'] }],
  },
  
  // Override rules for test files
  overrides: [
    {
      files: ['tests/**/*.js', '**/*.test.js'],
      rules: {
        // Allow longer lines in tests (assertion descriptions)
        'max-len': 'off',
        // Allow more complex expressions in tests
        'no-console': 'off',
      },
    },
    {
      files: ['bin/**/*.js'],
      rules: {
        // CLI entry points may need process.exit
        'no-process-exit': 'off',
      },
    },
    {
      // Security files intentionally use control characters in regex for sanitization
      files: ['lib/security.js', 'lib/chat-security.js'],
      rules: {
        'no-control-regex': 'off',
      },
    },
  ],
  
  // Global variables that are allowed
  globals: {
    // Jest globals (for test files)
    jest: 'readonly',
    describe: 'readonly',
    it: 'readonly',
    test: 'readonly',
    expect: 'readonly',
    beforeAll: 'readonly',
    afterAll: 'readonly',
    beforeEach: 'readonly',
    afterEach: 'readonly',
  },
  
  // Don't lint certain files/directories
  ignorePatterns: [
    'node_modules/',
    'coverage/',
    '*.min.js',
    'dist/',
    'build/',
  ],
};
