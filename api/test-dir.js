module.exports = (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ok:true, msg:'single segment works'})); };
