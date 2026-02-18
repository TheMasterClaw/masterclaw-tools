/**
 * safe-output.js - Safe Terminal Output Module for MasterClaw CLI
 *
 * Provides centralized output sanitization to prevent terminal escape sequence injection attacks:
 * - ANSI escape sequence filtering for untrusted data
 * - Terminal control character sanitization
 * - Safe output wrappers for console methods
 * - Support for both human and JSON output modes
 *
 * Security: Prevents terminal manipulation, log injection, and display-based attacks
 */

const chalk = require('chalk');
const { isJsonOutputMode } = require('./error-handler');
const { maskSensitiveData } = require('./security');

// =============================================================================
// Security Constants
// =============================================================================

/**
 * ANSI escape sequences that could be used for terminal manipulation.
 * These include cursor movement, screen clearing, and terminal title changes.
 * SAFE SGR codes (colors like \x1b[31m, \x1b[0m) are NOT included here.
 * @see https://en.wikipedia.org/wiki/ANSI_escape_code
 */
const DANGEROUS_ANSI_PATTERNS = [
  // Terminal title manipulation (can trick users)
  /\x1b\]0;[^\x07\x1b]*(?:\x07|\x1b\\)/g,  // OSC 0: Set window title
  /\x1b\]1;[^\x07\x1b]*(?:\x07|\x1b\\)/g,  // OSC 1: Set icon name
  /\x1b\]2;[^\x07\x1b]*(?:\x07|\x1b\\)/g,  // OSC 2: Set window title
  /\x1b\]4;[^\x07\x1b]*(?:\x07|\x1b\\)/g,  // OSC 4: Set color
  /\x1b\]10;[^\x07\x1b]*(?:\x07|\x1b\\)/g, // OSC 10: Set foreground
  /\x1b\]11;[^\x07\x1b]*(?:\x07|\x1b\\)/g, // OSC 11: Set background

  // Cursor manipulation (can hide malicious commands)
  /\x1b\[\?25l/g,               // Hide cursor
  /\x1b\[\?25h/g,               // Show cursor
  /\x1b\[\d+[A-G]/g,            // Cursor movement (up, down, forward, back, etc.)
  /\x1b\[\d*H/g,                // Cursor home
  /\x1b\[\d+;\d+H/g,            // Cursor position

  // Screen manipulation (can hide output)
  /\x1b\[2J/g,                  // Clear entire screen
  /\x1b\[1J/g,                  // Clear screen from cursor to beginning
  /\x1b\[0J/g,                  // Clear screen from cursor to end
  /\x1b\[3J/g,                  // Clear scrollback buffer
  /\x1b\[2K/g,                  // Clear entire line
  /\x1b\[1K/g,                  // Clear line from cursor to start
  /\x1b\[0K/g,                  // Clear line from cursor to end

  // Scroll region manipulation
  /\x1b\[\d*;\d*r/g,            // Set scroll region

  // Alternative screen buffer (can hide output)
  /\x1b\[\?\d+h/g,              // Set mode (including alternate screen)
  /\x1b\[\?\d+l/g,              // Reset mode

  // Bell character (can be annoying/used for DoS)
  /\x07/g,

  // General OSC sequences (Operating System Commands) - catch-all
  /\x1b\]\d*;[^\x07\x1b]*(?:\x07|\x1b\\)/g,

  // Device control strings (DCS)
  /\x1bP[^\x1b]*(?:\x1b\\|$)/gs,

  // Application Program Command (APC)
  /\x1b_[^\x1b]*(?:\x1b\\|$)/gs,

  // Privacy Message (PM)
  /\x1b\^[^\x1b]*(?:\x1b\\|$)/gs,

  // SOS (Start of String)
  /\x1bX[^\x1b]*(?:\x1b\\|$)/gs,
];

/**
 * Pattern to match SAFE SGR (Select Graphic Rendition) codes only.
 * These are standard color/formatting codes: \x1b[<n>m where n is 0-99
 * This excludes dangerous CSI sequences like cursor movement, screen clearing, etc.
 */
const SAFE_SGR_PATTERN = /\x1b\[(\d{1,2})m/g;

/**
 * Control characters that should never appear in terminal output
 * (except for common whitespace: \t, \n, \r and \x1b which is used for ANSI sequences)
 *
 * Note: \x1b (ESC, code 27) is intentionally EXCLUDED from this pattern
 * because it's required for legitimate ANSI color codes (e.g., \x1b[31m for red).
 * Dangerous ANSI sequences (cursor movement, screen clearing, etc.) are
 * handled separately by stripDangerousAnsi().
 *
 * Range breakdown:
 * - \x00-\x08: NUL through BS (null, control chars, bell, backspace)
 * - \x0b-\x0c: VT, FF (vertical tab, form feed)
 * - \x0e-\x1a: SO through SUB (shift out, device controls)
 * - \x1c-\x1f: FS through US (file/record/group/unit separators)
 * - \x7f: DEL (delete)
 * - \x1b (ESC): EXCLUDED - required for ANSI SGR color codes
 */
const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

/**
 * Unicode characters that can cause rendering issues or be used for spoofing
 */
const DANGEROUS_UNICODE = [
  // Bidirectional text characters (can be used to hide/reorder text)
  /\u202E/g,  // Right-to-Left Override (RLO)
  /\u202D/g,  // Left-to-Right Override (LRO)
  /\u202C/g,  // Pop Directional Formatting (PDF)
  /\u202B/g,  // Right-to-Left Embedding (RLE)
  /\u202A/g,  // Left-to-Right Embedding (LRE)
  /\u2029/g,  // Right-to-Left Isolate (RLI)
  /\u2028/g,  // Left-to-Right Isolate (LRI)
  /\u2069/g,  // Pop Directional Isolate (PDI)
  /\u2068/g,  // First Strong Isolate (FSI)

  // Zero-width characters (can be used for hidden data or spoofing)
  /\u200B/g,  // Zero Width Space
  /\u200C/g,  // Zero Width Non-Joiner
  /\u200D/g,  // Zero Width Joiner
  /\uFEFF/g,  // Zero Width No-Break Space (BOM)
  /\u2060/g,  // Word Joiner
  /\u2061/g,  // Function Application
  /\u2062/g,  // Invisible Times
  /\u2063/g,  // Invisible Separator
  /\u2064/g,  // Invisible Plus

  // Homoglyphs (commonly used for spoofing - just the most dangerous)
  /\u0430/g,  // Cyrillic 'а' (looks like Latin 'a')
  /\u0435/g,  // Cyrillic 'е' (looks like Latin 'e')
  /\u043E/g,  // Cyrillic 'о' (looks like Latin 'o')
  /\u0440/g,  // Cyrillic 'р' (looks like Latin 'p')
  /\u0441/g,  // Cyrillic 'с' (looks like Latin 'c')
  /\u0445/g,  // Cyrillic 'х' (looks like Latin 'x')
];

/** Maximum safe output line length (prevents line overflow attacks) */
const MAX_LINE_LENGTH = 10000;

/** Maximum number of newlines (prevents scroll DoS) */
const MAX_NEWLINES = 100;

// =============================================================================
// Core Sanitization Functions
// =============================================================================

/**
 * Removes dangerous ANSI escape sequences from a string.
 * Preserves safe SGR color/formatting codes that chalk uses.
 *
 * @param {string} str - String to sanitize
 * @returns {string} - Sanitized string
 */
function stripDangerousAnsi(str) {
  if (typeof str !== 'string') {
    return String(str);
  }

  let sanitized = str;

  // First pass: remove all dangerous CSI sequences (anything that's not a simple SGR code)
  // Match CSI sequences: \x1b[ followed by params and a final byte
  // We want to keep only simple SGR codes (ending in 'm' with numeric params)
  sanitized = sanitized.replace(/\x1b\[([\d;]*)[A-Za-z]/g, (match, params) => {
    // Check if this is a safe SGR code (ends with 'm' and has only numeric params 0-99)
    const lastChar = match.slice(-1);
    if (lastChar === 'm') {
      // It's an SGR code (color/formatting) - preserve it
      return match;
    }
    // It's a dangerous CSI sequence (cursor movement, screen clear, etc.) - remove it
    return '';
  });

  // Second pass: remove OSC and other dangerous sequences
  for (const pattern of DANGEROUS_ANSI_PATTERNS) {
    sanitized = sanitized.replace(pattern, '');
  }

  return sanitized;
}

/**
 * Removes control characters from a string.
 * Preserves tabs, newlines, and carriage returns for formatting.
 *
 * @param {string} str - String to sanitize
 * @returns {string} - Sanitized string
 */
function stripControlCharacters(str) {
  if (typeof str !== 'string') {
    return String(str);
  }

  return str.replace(CONTROL_CHARACTERS, '');
}

/**
 * Removes dangerous Unicode characters that can be used for spoofing or hiding data.
 *
 * @param {string} str - String to sanitize
 * @returns {string} - Sanitized string
 */
function stripDangerousUnicode(str) {
  if (typeof str !== 'string') {
    return String(str);
  }

  let sanitized = str;

  for (const pattern of DANGEROUS_UNICODE) {
    sanitized = sanitized.replace(pattern, '');
  }

  return sanitized;
}

/**
 * Truncates a string to a maximum length with an indicator.
 *
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length
 * @param {string} [indicator='...'] - Truncation indicator
 * @returns {string} - Truncated string
 */
function truncateString(str, maxLength, indicator = '...') {
  if (typeof str !== 'string') {
    str = String(str);
  }

  if (str.length <= maxLength) {
    return str;
  }

  const indicatorLength = indicator.length;
  const truncateAt = maxLength - indicatorLength;

  if (truncateAt <= 0) {
    return str.slice(0, maxLength);
  }

  return str.slice(0, truncateAt) + indicator;
}

/**
 * Limits the number of newlines in a string.
 * Prevents scroll-based DoS attacks.
 *
 * @param {string} str - String to process
 * @param {number} maxNewlines - Maximum newlines allowed
 * @returns {string} - Processed string
 */
function limitNewlines(str, maxNewlines = MAX_NEWLINES) {
  if (typeof str !== 'string') {
    str = String(str);
  }

  const newlineMatches = str.match(/\n/g);
  if (!newlineMatches || newlineMatches.length <= maxNewlines) {
    return str;
  }

  // Split by newlines and rejoin with limited count
  const parts = str.split('\n');
  const kept = parts.slice(0, maxNewlines + 1);
  const truncated = parts.length - kept.length;

  if (truncated > 0) {
    kept.push(`[${truncated} more lines truncated]`);
  }

  return kept.join('\n');
}

// =============================================================================
// Main Sanitization Function
// =============================================================================

/**
 * Comprehensive output sanitization for terminal display.
 * Applies all security filters to prevent terminal manipulation attacks.
 *
 * Security features:
 * - Removes dangerous ANSI escape sequences (cursor movement, screen clearing)
 * - Strips control characters
 * - Removes bidirectional text markers (text reordering attacks)
 * - Removes zero-width characters (hidden data attacks)
 * - Truncates long lines
 * - Limits excessive newlines
 * - Masks sensitive data patterns
 *
 * @param {*} data - Data to sanitize (will be converted to string)
 * @param {Object} options - Sanitization options
 * @param {boolean} [options.preserveColors=false] - If true, preserves chalk color codes (for trusted internal data)
 * @param {boolean} [options.maskSensitive=true] - Whether to mask sensitive data patterns
 * @param {number} [options.maxLength=MAX_LINE_LENGTH] - Maximum line length
 * @param {number} [options.maxNewlines=MAX_NEWLINES] - Maximum newlines
 * @returns {string} - Sanitized string safe for terminal output
 */
function sanitizeOutput(data, options = {}) {
  const {
    preserveColors = false,
    maskSensitive = true,
    maxLength = MAX_LINE_LENGTH,
    maxNewlines = MAX_NEWLINES,
  } = options;

  // Convert to string
  let str = typeof data === 'string' ? data : String(data);

  // Mask sensitive data first (before any transformations)
  if (maskSensitive) {
    str = maskSensitiveData(str);
  }

  // Strip dangerous ANSI sequences (unless preserving colors for trusted data)
  // When preserveColors is true, we only strip dangerous sequences like cursor
  // movement and screen clearing, but keep safe SGR color codes
  if (!preserveColors) {
    // Strip ALL ANSI sequences including colors
    str = str.replace(/\x1b\[[0-9;]*m/g, '');
    str = stripDangerousAnsi(str);
  } else {
    // Only strip dangerous sequences, preserve safe SGR color codes
    str = stripDangerousAnsi(str);
  }

  // Strip control characters
  str = stripControlCharacters(str);

  // Strip dangerous Unicode
  str = stripDangerousUnicode(str);

  // Limit newlines
  str = limitNewlines(str, maxNewlines);

  // Truncate to max length
  str = truncateString(str, maxLength);

  return str;
}

/**
 * Sanitizes output for JSON mode.
 * More restrictive than terminal mode since JSON is machine-readable.
 *
 * @param {*} data - Data to sanitize
 * @returns {string} - Sanitized string
 */
function sanitizeForJson(data) {
  let str = typeof data === 'string' ? data : String(data);

  // In JSON mode, strip ALL ANSI sequences (both safe color codes and dangerous ones)
  // First strip dangerous sequences
  str = stripDangerousAnsi(str);
  // Then strip remaining SGR (color) sequences
  str = str.replace(/\x1b\[[0-9;]*m/g, '');

  // Strip all control characters
  str = stripControlCharacters(str);

  // Strip dangerous Unicode
  str = stripDangerousUnicode(str);

  // Mask sensitive data
  str = maskSensitiveData(str);

  return str;
}

// =============================================================================
// Safe Output Functions
// =============================================================================

/**
 * Safely writes to stdout.
 * Automatically applies appropriate sanitization based on output mode.
 *
 * @param {...*} args - Arguments to output
 */
function safeStdout(...args) {
  const isJson = isJsonOutputMode();

  const sanitized = args.map(arg => {
    if (isJson) {
      return sanitizeForJson(arg);
    }
    return sanitizeOutput(arg, { preserveColors: false });
  });

  console.log(...sanitized);
}

/**
 * Safely writes to stderr.
 * Automatically applies appropriate sanitization based on output mode.
 *
 * @param {...*} args - Arguments to output
 */
function safeStderr(...args) {
  const isJson = isJsonOutputMode();

  const sanitized = args.map(arg => {
    if (isJson) {
      return sanitizeForJson(arg);
    }
    return sanitizeOutput(arg, { preserveColors: false });
  });

  console.error(...sanitized);
}

/**
 * Safely outputs a single line.
 * Useful for status messages and progress indicators.
 *
 * @param {string} message - Message to output
 * @param {Object} options - Output options
 * @param {boolean} [options.isError=false] - Whether to use stderr
 */
function safeLine(message, options = {}) {
  const { isError = false } = options;
  const isJson = isJsonOutputMode();

  let sanitized;
  if (isJson) {
    sanitized = sanitizeForJson(message);
  } else {
    sanitized = sanitizeOutput(message);
  }

  if (isError) {
    console.error(sanitized);
  } else {
    console.log(sanitized);
  }
}

/**
 * Creates a formatted output string with sanitized user data.
 * Use this for constructing messages that include untrusted data.
 *
 * @param {string} template - Template string with {placeholders}
 * @param {Object} values - Values to insert (will be sanitized)
 * @returns {string} - Formatted and sanitized string
 *
 * @example
 * safeFormat('User {name} logged in from {ip}', { name: userInput, ip: ipAddress })
 * // => 'User [sanitized] logged in from [sanitized]'
 */
function safeFormat(template, values = {}) {
  let result = template;

  for (const [key, value] of Object.entries(values)) {
    const placeholder = `{${key}}`;
    const sanitized = sanitizeOutput(value);
    result = result.replaceAll(placeholder, sanitized);
  }

  return result;
}

/**
 * Safely outputs a table with sanitized data.
 *
 * @param {Array<Object>} data - Array of objects to display
 * @param {Array<string>} [columns] - Columns to display
 */
function safeTable(data, columns) {
  if (!Array.isArray(data) || data.length === 0) {
    safeLine('No data to display');
    return;
  }

  // Sanitize all data
  const sanitized = data.map(row => {
    const clean = {};
    for (const [key, value] of Object.entries(row)) {
      clean[key] = sanitizeOutput(value);
    }
    return clean;
  });

  console.table(sanitized, columns);
}

/**
 * Safely outputs JSON data.
 * Ensures proper escaping and sanitization.
 *
 * @param {*} data - Data to output as JSON
 * @param {Object} options - Options
 * @param {number} [options.indent=2] - Indentation
 */
function safeJson(data, options = {}) {
  const { indent = 2 } = options;

  try {
    // If it's a string, sanitize it first
    if (typeof data === 'string') {
      data = sanitizeForJson(data);
    } else if (typeof data === 'object' && data !== null) {
      // Recursively sanitize object values
      data = sanitizeObjectForJson(data);
    }

    const json = JSON.stringify(data, null, indent);
    console.log(json);
  } catch (err) {
    console.error(JSON.stringify({
      error: 'Failed to serialize output',
      message: sanitizeForJson(err.message),
    }));
  }
}

/**
 * Recursively sanitizes an object for JSON output.
 *
 * @param {*} obj - Object to sanitize
 * @returns {*} - Sanitized object
 */
function sanitizeObjectForJson(obj) {
  if (typeof obj === 'string') {
    return sanitizeForJson(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObjectForJson(item));
  }

  if (typeof obj === 'object' && obj !== null) {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizeObjectForJson(value);
    }
    return sanitized;
  }

  return obj;
}

// =============================================================================
// Chalk Integration
// =============================================================================

/**
 * Creates a chalk-style color function that automatically sanitizes its input.
 * Use this for colored output that includes user data.
 *
 * @param {Function} colorFn - Chalk color function (e.g., chalk.red)
 * @returns {Function} - Safe color function
 *
 * @example
 * const safeRed = safeColor(chalk.red);
 * console.log(safeRed(userInput)); // User input is sanitized, color is preserved
 */
function safeColor(colorFn) {
  return (text) => {
    // First sanitize the input (preserveColors=true so safe ANSI is kept)
    // Then apply the color function
    // Finally ensure no dangerous sequences were introduced
    const sanitized = sanitizeOutput(String(text), { preserveColors: true });
    return colorFn(sanitized);
  };
}

/**
 * Predefined safe color functions for common use cases.
 */
const safeColors = {
  red: safeColor(chalk.red),
  green: safeColor(chalk.green),
  yellow: safeColor(chalk.yellow),
  blue: safeColor(chalk.blue),
  magenta: safeColor(chalk.magenta),
  cyan: safeColor(chalk.cyan),
  gray: safeColor(chalk.gray),
  bold: safeColor(chalk.bold),
  italic: safeColor(chalk.italic),
};

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Checks if a string contains dangerous terminal sequences.
 * Useful for validation before output.
 *
 * @param {string} str - String to check
 * @returns {Object} - { safe: boolean, issues: string[] }
 */
function checkOutputSafety(str) {
  const issues = [];

  if (typeof str !== 'string') {
    return { safe: true, issues: [] };
  }

  // Check for dangerous ANSI sequences (recreate patterns without g flag to avoid state issues)
  const dangerousAnsiPatterns = [
    /\x1b\]0;[^\x07\x1b]*(?:\x07|\x1b\\)/,   // OSC 0
    /\x1b\]1;[^\x07\x1b]*(?:\x07|\x1b\\)/,   // OSC 1
    /\x1b\]2;[^\x07\x1b]*(?:\x07|\x1b\\)/,   // OSC 2
    /\x1b\[\?25[lh]/,                       // Cursor hide/show
    /\x1b\[\d+[A-G]/,                        // Cursor movement
    /\x1b\[\d*H/,                             // Cursor home
    /\x1b\[\d+;\d+H/,                         // Cursor position
    /\x1b\[[0123]?[JK]/,                      // Clear screen/line
    /\x1b\[\d*;\d*r/,                         // Scroll region
    /\x1b\[\?\d+[hl]/,                        // Set/reset mode
    /\x07/,                                   // Bell
  ];
  for (const pattern of dangerousAnsiPatterns) {
    if (pattern.test(str)) {
      issues.push('Contains dangerous ANSI escape sequence');
      break;
    }
  }

  // Check for control characters (recreate regex to avoid state issues)
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(str)) {
    issues.push('Contains control characters');
  }

  // Check for dangerous Unicode (recreate patterns to avoid state issues)
  const dangerousUnicodeChars = /[\u202E\u202D\u202C\u202B\u202A\u2029\u2028\u2069\u2068\u200B\u200C\u200D\uFEFF\u2060\u2061\u2062\u2063\u2064\u0430\u0435\u043E\u0440\u0441\u0445]/;
  if (dangerousUnicodeChars.test(str)) {
    issues.push('Contains dangerous Unicode characters');
  }

  // Check length
  if (str.length > MAX_LINE_LENGTH) {
    issues.push(`Exceeds maximum length (${str.length} > ${MAX_LINE_LENGTH})`);
  }

  // Check newlines
  const newlineCount = (str.match(/\n/g) || []).length;
  if (newlineCount > MAX_NEWLINES) {
    issues.push(`Too many newlines (${newlineCount} > ${MAX_NEWLINES})`);
  }

  return {
    safe: issues.length === 0,
    issues,
  };
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Core sanitization
  sanitizeOutput,
  sanitizeForJson,
  sanitizeObjectForJson,

  // Specific sanitizers
  stripDangerousAnsi,
  stripControlCharacters,
  stripDangerousUnicode,
  truncateString,
  limitNewlines,

  // Safe output functions
  safeStdout,
  safeStderr,
  safeLine,
  safeFormat,
  safeTable,
  safeJson,

  // Color integration
  safeColor,
  safeColors,

  // Validation
  checkOutputSafety,

  // Constants
  MAX_LINE_LENGTH,
  MAX_NEWLINES,
  DANGEROUS_ANSI_PATTERNS,
  CONTROL_CHARACTERS,
  DANGEROUS_UNICODE,
};
