// Shared: Standard response formatting helper
// Provides consistent JSON response formatting for all Edge Functions.
// All responses include CORS headers for cross-origin access.

import { corsHeaders } from './cors.ts';

/**
 * Create a successful JSON response.
 * Returns the data payload directly (no wrapper).
 *
 * @param data - The response payload
 * @param status - HTTP status code (default: 200)
 * @returns Response with JSON body and CORS headers
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    },
  );
}

/**
 * Create an error JSON response.
 * Follows the standard error format: { success: false, error: { code, message, details? } }
 *
 * @param message - Human-readable error message (Vietnamese)
 * @param status - HTTP status code (default: 400)
 * @param code - Machine-readable error code (default: 'BAD_REQUEST')
 * @param details - Optional additional context
 * @returns Response with JSON error body and CORS headers
 */
export function errorResponse(
  message: string,
  status = 400,
  code = 'BAD_REQUEST',
  details?: unknown,
): Response {
  const body: Record<string, unknown> = {
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };

  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    },
  );
}
