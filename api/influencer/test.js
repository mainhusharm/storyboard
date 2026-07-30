module.exports = (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ok:true, path:req.url})); };
