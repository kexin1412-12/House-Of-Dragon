const { ANTI_BLOAT_RULES } = require('./anti-bloat');
const { COMPANION_ROLE } = require('./companion-role');
const { SPOILER_BOUNDARY } = require('./spoiler-boundary');
const { EVIDENCE_PRIORITY } = require('./evidence-priority');
const { POWER_SUBTEXT } = require('./power-subtext');
const { COMPANION_STYLE } = require('./companion-style');

function buildCompanionCorePrompt() {
  return [
    COMPANION_ROLE,
    SPOILER_BOUNDARY,
    EVIDENCE_PRIORITY,
    POWER_SUBTEXT,
    COMPANION_STYLE,
    ANTI_BLOAT_RULES,
  ].join('\n');
}

module.exports = { buildCompanionCorePrompt };
