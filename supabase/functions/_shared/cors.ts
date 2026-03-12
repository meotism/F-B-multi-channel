// Shared: CORS headers helper
// Provides standard CORS headers for all Edge Functions.
// In production, Access-Control-Allow-Origin should be set to the
// GitHub Pages domain. During development, wildcard is acceptable.

/**
 * Standard CORS headers for Edge Function responses.
 * All responses (success and error) must include these headers.
 */
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

/**
 * Handle CORS preflight (OPTIONS) requests.
 * Returns a 204 No Content response with CORS headers.
 */
export function handleCorsPreflightRequest(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}
