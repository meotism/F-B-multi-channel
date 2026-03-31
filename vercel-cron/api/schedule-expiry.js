// Vercel Serverless Function - Schedule a reservation expiry via Upstash QStash
// Called by the frontend when creating a reservation.
// Publishes a delayed message to QStash that will call /api/process-tasks
// at the exact time the reservation should expire.

import { Client } from '@upstash/qstash';

const qstash = new Client({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Simple auth: verify Supabase anon key as bearer token
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.SUPABASE_ANON_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { reservationId, scheduleFor } = req.body || {};
  if (!reservationId || !scheduleFor) {
    return res.status(400).json({ error: 'Missing reservationId or scheduleFor' });
  }

  try {
    const delaySeconds = Math.max(
      0,
      Math.floor((new Date(scheduleFor).getTime() - Date.now()) / 1000)
    );

    // Get the base URL for the process-tasks endpoint
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.DEPLOY_URL;

    const result = await qstash.publishJSON({
      url: `${baseUrl}/api/process-tasks`,
      delay: delaySeconds,
      body: { reservationId },
    });

    return res.status(200).json({
      messageId: result.messageId,
      delaySeconds,
    });
  } catch (err) {
    console.error('[schedule-expiry] QStash publish failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
