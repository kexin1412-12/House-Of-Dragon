const { IDENTITY_LAYER } = require('./identity');
const { GROUNDING_LAYER } = require('./grounding');
const { ANALYSIS_LAYER } = require('./analysis');
const { STYLE_LAYER } = require('./style');
const { buildVisionUserContent } = require('./user');

function buildVisionSystemPrompt() {
  return [IDENTITY_LAYER, GROUNDING_LAYER, ANALYSIS_LAYER, STYLE_LAYER].join('\n');
}

module.exports = {
  buildVisionSystemPrompt,
  buildVisionUserContent,
};
