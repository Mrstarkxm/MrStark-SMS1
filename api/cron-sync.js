// Optional Vercel Cron entrypoint. Protects Lamix sync from public access.
const carrier = require('../lib/carrier');
const db = require('../lib/db');

module.exports = async (req, res) => {
  const auth = String(req.headers.authorization || '');
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret || auth !== `Bearer ${secret}`) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }
  try {
    await db.initializePersistentDb();
    const result = await carrier.runSync();
    await db.flushPersistence();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, result }));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: error.message }));
  }
};
