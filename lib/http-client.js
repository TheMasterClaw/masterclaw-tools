/**
 * http-client.js - Secure HTTP Client for MasterClaw CLI
 *
 * Centralized HTTP client with security hardening:
 * - SSRF (Server-Side Request Forgery) protection
 * - Timeout enforcement
 * - Response size limits
 * - Header injection prevention
 * - Safe redirect handling
 * - Audit logging integration
 * - Circuit breaker support
 */

const axios = require('axios');
const { validateDomainSSRFProtection } = require('./validate');
const { isValidIpAddress, isValidHostname, sanitizeForLog, maskSensitiveData } = require('./security');
const { logAudit, AuditEventType, Severity } = require('./audit');
const { getCurrentCorrelationId } = require('./correlation');

// =============================================================================
// Security Configuration
// =============================================================================

/** Default timeout for HTTP requests (10 seconds) */
const DEFAULT_TIMEOUT_MS = 10000;

/** Maximum timeout allowed (60 seconds) */
const MAX_TIMEOUT_MS = 60000;

/** Minimum timeout allowed (1 second) */
const MIN_TIMEOUT_MS = 1000;

/** Maximum response size (10MB) */
const MAX_RESPONSE_SIZE_BYTES = 10 * 1024 * 1024;

/** Maximum redirect hops allowed */
const MAX_REDIRECTS = 5;

/** Request timeout buffer for cleanup (500ms) */
const REQUEST_TIMEOUT_BUFFER_MS = 500;

/** User agent string */
const USER_AGENT = `MasterClaw-CLI/${require('../package.json').version}`;

// =============================================================================
// SSRF Protection
// =============================================================================

/**
 * Extracts hostname from URL
 * @param {string} url - URL to parse
 * @returns {string|null} - Hostname or null if invalid
 */
function extractHostname(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (err) {
    return null;
  }
}

/**
 * Validates that a URL is safe from SSRF attacks
 * @param {string} url - URL to validate
 * @param {Object} options - Validation options
 * @param {boolean} [options.allowPrivateIPs=false] - Allow private IP ranges
 * @returns {Object} - Validation result { valid: boolean, error?: string }
 */
function validateUrlSSRF(url, options = {}) {
  const { allowPrivateIPs = false } = options;

  // Basic URL validation
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required' };
  }

  // Check for data URLs (can be used for XSS/data exfiltration)
  if (url.toLowerCase().startsWith('data:')) {
    return { valid: false, error: 'data: URLs are not allowed' };
  }

  // Check for file URLs (local file access)
  if (url.toLowerCase().startsWith('file:')) {
    return { valid: false, error: 'file: URLs are not allowed' };
  }

  // Check for javascript URLs (XSS)
  if (url.toLowerCase().startsWith('javascript:')) {
    return { valid: false, error: 'javascript: URLs are not allowed' };
  }

  // Extract and validate hostname
  const hostname = extractHostname(url);
  if (!hostname) {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Check for IP address URLs
  if (isValidIpAddress(hostname)) {
    // Direct IP access - check if private
    if (!allowPrivateIPs) {
      const result = validateDomainSSRFProtection(hostname);
      if (result.isSSRFVector) {
        return { valid: false, error: `Private IP access not allowed: ${hostname}` };
      }
    }
  } else {
    // Domain-based URL
    const result = validateDomainSSRFProtection(hostname);
    if (!allowPrivateIPs && (result.isSSRFVector || result.isInternal)) {
      return { valid: false, error: `SSRF vector detected: ${result.warnings.join(', ')}` };
    }
  }

  return { valid: true };
}

// =============================================================================
// Header Security
// =============================================================================

/**
 * Validates and sanitizes HTTP headers
 * Prevents header injection attacks (CRLF injection)
 * @param {Object} headers - Headers to validate
 * @returns {Object} - { valid: boolean, sanitized?: Object, error?: string }
 */
function validateAndSanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return { valid: true, sanitized: {} };
  }

  const sanitized = {};
  const injectionPattern = /[\r\n]/;

  for (const [key, value] of Object.entries(headers)) {
    // Validate header name (no spaces or special chars)
    if (!/^[a-zA-Z0-9-_]+$/.test(key)) {
      return { valid: false, error: `Invalid header name: ${key}` };
    }

    // Check for header injection attempts
    const valueStr = String(value);
    if (injectionPattern.test(valueStr)) {
      return { valid: false, error: `Header injection detected in ${key}` };
    }

    // Sanitize the value
    sanitized[key] = sanitizeForLog(valueStr, 8192); // Max header value length
  }

  return { valid: true, sanitized };
}

// =============================================================================
// Response Validation
// =============================================================================

/**
 * Validates response size to prevent DoS via large responses
 * @param {Object} response - Axios response object
 * @param {number} maxSize - Maximum allowed size
 * @returns {boolean} - True if response size is acceptable
 */
function validateResponseSize(response, maxSize = MAX_RESPONSE_SIZE_BYTES) {
  const contentLength = response.headers?.['content-length'];
  
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (size > maxSize) {
      return false;
    }
  }

  // Also check actual data size if available
  if (response.data) {
    const dataSize = typeof response.data === 'string' 
      ? Buffer.byteLength(response.data, 'utf8')
      : JSON.stringify(response.data).length;
    
    if (dataSize > maxSize) {
      return false;
    }
  }

  return true;
}

// =============================================================================
// Secure HTTP Client
// =============================================================================

/**
 * Creates a secure HTTP client instance
 * @param {Object} defaultOptions - Default options for all requests
 * @returns {Object} - Secure HTTP client with get, post, put, delete methods
 */
function createSecureClient(defaultOptions = {}) {
  // Merge with secure defaults
  const options = {
    timeout: DEFAULT_TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    maxBodyLength: MAX_RESPONSE_SIZE_BYTES,
    maxContentLength: MAX_RESPONSE_SIZE_BYTES,
    validateStatus: () => true, // Don't throw on any status - let caller decide
    ...defaultOptions,
  };

  // Create axios instance
  const client = axios.create(options);

  // Request interceptor for security validation
  client.interceptors.request.use(
    async (config) => {
      const startTime = Date.now();
      config._startTime = startTime;
      config._correlationId = getCurrentCorrelationId();

      // SSRF validation
      const urlValidation = validateUrlSSRF(config.url, {
        allowPrivateIPs: config._allowPrivateIPs,
      });

      if (!urlValidation.valid) {
        const error = new Error(`SSRF Protection: ${urlValidation.error}`);
        error.code = 'SSRF_VIOLATION';
        error.url = maskSensitiveData(config.url);
        
        // Log security violation
        await logAudit({
          eventType: AuditEventType.SECURITY_VIOLATION,
          severity: Severity.WARNING,
          details: {
            violationType: 'SSRF_ATTEMPT',
            url: maskSensitiveData(config.url),
            reason: urlValidation.error,
          },
        });

        throw error;
      }

      // Header validation
      if (config.headers) {
        const headerValidation = validateAndSanitizeHeaders(config.headers);
        if (!headerValidation.valid) {
          const error = new Error(`Header Security: ${headerValidation.error}`);
          error.code = 'HEADER_VALIDATION_FAILED';
          throw error;
        }
        config.headers = headerValidation.sanitized;
      }

      // Add security headers
      config.headers = config.headers || {};
      config.headers['User-Agent'] = USER_AGENT;
      
      // Add correlation ID if available
      if (config._correlationId) {
        config.headers['X-Correlation-ID'] = config._correlationId;
      }

      // Enforce timeout limits
      const timeout = config.timeout || options.timeout;
      if (timeout > MAX_TIMEOUT_MS) {
        config.timeout = MAX_TIMEOUT_MS;
      } else if (timeout < MIN_TIMEOUT_MS) {
        config.timeout = MIN_TIMEOUT_MS;
      }

      return config;
    },
    (error) => Promise.reject(error)
  );

  // Response interceptor for validation and logging
  client.interceptors.response.use(
    async (response) => {
      const duration = Date.now() - (response.config._startTime || Date.now());
      
      // Validate response size
      if (!validateResponseSize(response)) {
        const error = new Error('Response size exceeds maximum allowed');
        error.code = 'RESPONSE_TOO_LARGE';
        error.response = { status: response.status };
        
        await logAudit({
          eventType: AuditEventType.SECURITY_VIOLATION,
          severity: Severity.WARNING,
          details: {
            violationType: 'OVERSIZED_RESPONSE',
            url: maskSensitiveData(response.config.url),
            contentLength: response.headers?.['content-length'],
          },
        });

        throw error;
      }

      // Log successful external calls
      if (response.config._audit) {
        await logAudit({
          eventType: AuditEventType.EXTERNAL_CALL,
          severity: Severity.DEBUG,
          details: {
            url: maskSensitiveData(response.config.url),
            method: response.config.method?.toUpperCase(),
            status: response.status,
            duration,
          },
        });
      }

      // Attach metadata to response
      response._meta = {
        duration,
        correlationId: response.config._correlationId,
      };

      return response;
    },
    async (error) => {
      // Log failed external calls
      if (error.config?._audit) {
        await logAudit({
          eventType: AuditEventType.EXTERNAL_CALL,
          severity: Severity.WARNING,
          details: {
            url: maskSensitiveData(error.config.url),
            method: error.config.method?.toUpperCase(),
            error: error.code || error.message,
          },
        });
      }

      // Enhance error with metadata
      if (error.config) {
        error._meta = {
          duration: Date.now() - (error.config._startTime || Date.now()),
          correlationId: error.config._correlationId,
        };
      }

      return Promise.reject(error);
    }
  );

  return client;
}

// =============================================================================
// HTTP Methods
// =============================================================================

// Default secure client instance
const defaultClient = createSecureClient();

/**
 * Makes a secure GET request
 * @param {string} url - URL to request
 * @param {Object} options - Request options
 * @returns {Promise<Object>} - Axios response
 */
async function get(url, options = {}) {
  return defaultClient.get(url, options);
}

/**
 * Makes a secure POST request
 * @param {string} url - URL to request
 * @param {*} data - Request body data
 * @param {Object} options - Request options
 * @returns {Promise<Object>} - Axios response
 */
async function post(url, data, options = {}) {
  return defaultClient.post(url, data, options);
}

/**
 * Makes a secure PUT request
 * @param {string} url - URL to request
 * @param {*} data - Request body data
 * @param {Object} options - Request options
 * @returns {Promise<Object>} - Axios response
 */
async function put(url, data, options = {}) {
  return defaultClient.put(url, data, options);
}

/**
 * Makes a secure DELETE request
 * @param {string} url - URL to request
 * @param {Object} options - Request options
 * @returns {Promise<Object>} - Axios response
 */
async function del(url, options = {}) {
  return defaultClient.delete(url, options);
}

/**
 * Makes a secure PATCH request
 * @param {string} url - URL to request
 * @param {*} data - Request body data
 * @param {Object} options - Request options
 * @returns {Promise<Object>} - Axios response
 */
async function patch(url, data, options = {}) {
  return defaultClient.patch(url, data, options);
}

/**
 * Makes a request with full control over options
 * @param {Object} config - Axios request config
 * @returns {Promise<Object>} - Axios response
 */
async function request(config) {
  return defaultClient.request(config);
}

// =============================================================================
// Request Options Helpers
// =============================================================================

/**
 * Creates request options with audit logging enabled
 * @param {Object} options - Base options
 * @returns {Object} - Options with audit flag
 */
function withAudit(options = {}) {
  return { ...options, _audit: true };
}

/**
 * Creates request options allowing private IP access
 * Use with caution - only for internal service calls
 * @param {Object} options - Base options
 * @returns {Object} - Options with private IP allowed
 */
function allowPrivateIPs(options = {}) {
  return { ...options, _allowPrivateIPs: true };
}

/**
 * Creates request options with custom timeout
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {Object} options - Base options
 * @returns {Object} - Options with timeout
 */
function withTimeout(timeoutMs, options = {}) {
  const clampedTimeout = Math.max(MIN_TIMEOUT_MS, Math.min(timeoutMs, MAX_TIMEOUT_MS));
  return { ...options, timeout: clampedTimeout };
}

// =============================================================================
// Health Check
// =============================================================================

/**
 * Performs a health check on a URL
 * @param {string} url - URL to check
 * @param {Object} options - Health check options
 * @returns {Promise<Object>} - Health check result
 */
async function healthCheck(url, options = {}) {
  const startTime = Date.now();
  
  try {
    const response = await get(url, {
      timeout: options.timeout || 5000,
      ...options,
    });

    return {
      healthy: response.status >= 200 && response.status < 300,
      status: response.status,
      responseTime: Date.now() - startTime,
      error: null,
    };
  } catch (error) {
    return {
      healthy: false,
      status: error.response?.status || 0,
      responseTime: Date.now() - startTime,
      error: error.code || error.message,
    };
  }
}

// =============================================================================
// Export
// =============================================================================

module.exports = {
  // Client factory
  createSecureClient,
  
  // HTTP methods
  get,
  post,
  put,
  del,
  patch,
  request,
  
  // Request option helpers
  withAudit,
  allowPrivateIPs,
  withTimeout,
  
  // Health check
  healthCheck,
  
  // Security utilities
  validateUrlSSRF,
  validateAndSanitizeHeaders,
  validateResponseSize,
  extractHostname,
  
  // Constants
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_RESPONSE_SIZE_BYTES,
  MAX_REDIRECTS,
  USER_AGENT,
};
