/**
 * chat-security.js - Security utilities for chat commands
 *
 * Provides input validation and sanitization for the chat command:
 * - Message length limits to prevent abuse
 * - Dangerous character/pattern detection
 * - Input sanitization to prevent injection attacks
 * - Rate limiting integration
 */

// =============================================================================
// Security Constants
// =============================================================================

/** Maximum message length (10,000 characters) */
const MAX_MESSAGE_LENGTH = 10000;

/** Minimum message length (non-empty) */
const MIN_MESSAGE_LENGTH = 1;

/** Maximum allowed line count (prevent log flooding) */
const MAX_LINE_COUNT = 100;

/** Dangerous patterns that could indicate injection attempts - using functions to avoid regex state issues */
const DANGEROUS_PATTERNS = [
  // Script tags and HTML - returns true if dangerous content found
  (input) => /<script\b/i.test(input) && /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/i.test(input),
  (input) => /<iframe\b/i.test(input) && /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/i.test(input),
  (input) => /<object\b/i.test(input) && /<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/i.test(input),
  (input) => /<embed\b/i.test(input),
  (input) => /javascript:/i.test(input),
  (input) => /on\w+\s*=/i.test(input), // Event handlers like onclick=
  (input) => /data:text\/html/i.test(input),
];

/** Control characters that should be removed (excluding \x1b which is handled by ANSI_ESCAPE) */
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

/** ANSI escape sequences - comprehensive pattern for all ANSI codes */
const ANSI_ESCAPE = /\x1b\[[0-9;]*[a-zA-Z0-9]/g;

/** Unicode homoglyph/spoofing characters */
const SUSPICIOUS_UNICODE = /[\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g;

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validates chat input for security and format compliance
 *
 * @param {string} input - Raw user input
 * @returns {Object} - Validation result with { valid: boolean, error?: string }
 */
function validateChatInput(input) {
  // Type check
  if (typeof input !== 'string') {
    return { valid: false, error: 'Message must be a string' };
  }

  // Check for empty input
  if (input.length < MIN_MESSAGE_LENGTH) {
    return { valid: false, error: 'Message cannot be empty' };
  }

  // Check maximum length
  if (input.length > MAX_MESSAGE_LENGTH) {
    return {
      valid: false,
      error: `Message too long (${input.length} characters). Maximum is ${MAX_MESSAGE_LENGTH} characters.`
    };
  }

  // Check line count (prevent log flooding)
  const lineCount = (input.match(/\n/g) || []).length + 1;
  if (lineCount > MAX_LINE_COUNT) {
    return {
      valid: false,
      error: `Message contains too many lines (${lineCount}). Maximum is ${MAX_LINE_COUNT} lines.`
    };
  }

  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern(input)) {
      return {
        valid: false,
        error: 'Message contains potentially dangerous content (HTML/script tags)'
      };
    }
  }

  // Check for null bytes
  if (input.includes('\0')) {
    return { valid: false, error: 'Message contains invalid characters (null bytes)' };
  }

  return { valid: true };
}

/**
 * Checks if input contains suspicious patterns (non-blocking check)
 * Used for audit logging, not for blocking
 *
 * @param {string} input - User input
 * @returns {Object} - Analysis result with flags
 */
function analyzeInputRisk(input) {
  const risks = [];

  // Handle non-string input
  if (typeof input !== 'string') {
    return { risky: false, risks };
  }

  // Check for excessive repetition (DoS pattern)
  const repeatedChars = /(.)\1{50,}/;
  if (repeatedChars.test(input)) {
    risks.push('excessive_repetition');
  }

  // Check for excessive whitespace
  const excessiveWhitespace = input.match(/\s{100,}/);
  if (excessiveWhitespace) {
    risks.push('excessive_whitespace');
  }

  // Check for suspicious Unicode
  if (SUSPICIOUS_UNICODE.test(input)) {
    risks.push('suspicious_unicode');
  }

  // Check for mixed scripts (potential spoofing)
  const hasLatin = /[a-zA-Z]/.test(input);
  const hasCyrillic = /[\u0400-\u04FF]/.test(input);
  const hasGreek = /[\u0370-\u03FF]/.test(input);
  const scriptCount = [hasLatin, hasCyrillic, hasGreek].filter(Boolean).length;
  if (scriptCount > 1) {
    risks.push('mixed_scripts');
  }

  return {
    risky: risks.length > 0,
    risks,
  };
}

// =============================================================================
// Sanitization Functions
// =============================================================================

/**
 * Sanitizes chat input for safe transmission
 * Removes control characters and normalizes whitespace
 *
 * @param {string} input - Raw user input
 * @returns {string} - Sanitized input
 */
function sanitizeChatInput(input) {
  if (typeof input !== 'string') {
    return '';
  }

  let sanitized = input;

  // Remove control characters
  sanitized = sanitized.replace(CONTROL_CHARS, '');

  // Remove ANSI escape sequences
  sanitized = sanitized.replace(ANSI_ESCAPE, '');

  // Remove suspicious Unicode characters (zero-width spaces, directional markers)
  sanitized = sanitized.replace(SUSPICIOUS_UNICODE, '');

  // Normalize line endings (CRLF -> LF)
  sanitized = sanitized.replace(/\r\n/g, '\n');
  sanitized = sanitized.replace(/\r/g, '\n');

  // Trim leading/trailing whitespace
  sanitized = sanitized.trim();

  // Normalize multiple consecutive newlines (max 2)
  sanitized = sanitized.replace(/\n{3,}/g, '\n\n');

  // Limit consecutive spaces
  sanitized = sanitized.replace(/ {3,}/g, '  ');

  return sanitized;
}

/**
 * Truncates message to maximum length with ellipsis
 *
 * @param {string} input - Input string
 * @param {number} maxLength - Maximum length (default: MAX_MESSAGE_LENGTH)
 * @returns {string} - Truncated string
 */
function truncateMessage(input, maxLength = MAX_MESSAGE_LENGTH) {
  if (typeof input !== 'string') {
    return '';
  }

  if (input.length <= maxLength) {
    return input;
  }

  // Truncate and add ellipsis
  return `${input.substring(0, maxLength - 3)  }...`;
}

/**
 * Masks sensitive patterns in chat messages for logging
 * Removes tokens, API keys, passwords from logged output
 *
 * @param {string} input - Input message
 * @returns {string} - Masked message safe for logging
 */
function maskSensitiveInMessage(input) {
  if (typeof input !== 'string') {
    return '';
  }

  let masked = input;

  // Mask common sensitive patterns
  const sensitivePatterns = [
    { pattern: /\b[a-f0-9]{32,}\b/gi, replacement: '[HEX_TOKEN]' }, // Hex tokens
    { pattern: /\beyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\b/g, replacement: '[JWT]' }, // JWT tokens
    { pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g, replacement: '[API_KEY]' }, // OpenAI-style keys
    { pattern: /password([:=])\s*\S+/gi, replacement: 'password$1[REDACTED]' },
    { pattern: /token([:=])\s*\S+/gi, replacement: 'token$1[REDACTED]' },
    { pattern: /api([_-]?)key([:=])\s*\S+/gi, replacement: 'api$1key$2[REDACTED]' },
  ];

  for (const { pattern, replacement } of sensitivePatterns) {
    masked = masked.replace(pattern, replacement);
  }

  return masked;
}

// =============================================================================
// Export
// =============================================================================

module.exports = {
  // Validation
  validateChatInput,
  analyzeInputRisk,

  // Sanitization
  sanitizeChatInput,
  truncateMessage,
  maskSensitiveInMessage,

  // Constants
  MAX_MESSAGE_LENGTH,
  MIN_MESSAGE_LENGTH,
  MAX_LINE_COUNT,
  DANGEROUS_PATTERNS,
};
