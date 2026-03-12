// Edge Function: Merge/transfer order logic
// Handles merging tables and transferring orders between tables
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

serve(async (req: Request) => {
  // TODO: Implement merge/transfer order logic
  return new Response(JSON.stringify({ message: 'Not implemented' }), {
    status: 501,
    headers: { 'Content-Type': 'application/json' },
  });
});
