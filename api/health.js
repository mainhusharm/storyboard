// Lightweight health check — does not load the full server
module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, vercel: !!process.env.VERCEL, node: process.version, ts: Date.now() }));
};
