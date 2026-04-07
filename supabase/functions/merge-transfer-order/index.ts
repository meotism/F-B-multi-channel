// Edge Function: Merge/transfer order logic (stub)
// Handles merging tables and transferring orders between tables
// TODO: Implement merge/transfer order logic

import { handleCorsPreflightRequest } from '../_shared/cors.ts';
import { errorResponse } from '../_shared/response.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return handleCorsPreflightRequest();
  }

  return errorResponse('Tính năng chưa được triển khai', 501, 'NOT_IMPLEMENTED');
});
