// Public entry — retrieval moved into ./retrieval/. Kept as a shim so
// require('./lib/retrieval') stays valid for existing callers.
module.exports = require('./retrieval/index.js');
