// Vercel Serverless Function - Process due scheduled tasks
// Called by Upstash QStash at the exact scheduled time for each reservation.
// Invokes Supabase RPC process_due_tasks() to expire overdue reservations.

import { createClient } from '@supabase/supabase-js';
import { Receiver } from '@upstash/qstash';

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

export default async function handler(req, res) {
  // Verify QStash signature
  try {
    const signature = req.headers['upstash-signature'];
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const isValid = await receiver.verify({ signature, body });
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid QStash signature' });
    }
  } catch (err) {
    console.error('[process-tasks] QStash verification failed:', err.message);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data, error } = await supabase.rpc('process_due_tasks');

    if (error) {
      console.error('[process-tasks] RPC error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ processed: data, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[process-tasks] Unexpected error:', err);
    return res.status(500).json({ error: err.message });
  }
}
