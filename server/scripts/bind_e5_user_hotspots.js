// 一次性脚本：把用户提供的 10 条 S1E5 hotspot 锚定到 house_of_dragon_05.json 的具体 scene
// 用户给的时间戳来自外部源（差 +11min），已通过内容验证后映射到 scene_id
const fs = require('fs');
const path = require('path');

const KB_PATH = path.join(__dirname, '..', 'kb', 'house_of_dragon_05.json');
const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));

const BINDINGS = [
  {
    scene_id: 's477',
    symbol_id: 'viserys_carving_squab',
    evidence_in_frame: '婚宴主位，韦赛里斯起身致辞，桌前有切到一半的乳鸽与餐刀；他手上的伤口绷带在烛光下可见，刀工凌乱。',
    confidence: 'high',
  },
  {
    scene_id: 's51',
    symbol_id: 'royce_bronze_runic_armor',
    evidence_in_frame: '蕾雅·罗伊斯（KB 中识别为"莱娜·瓦列利安"）身着雕刻先民符文的青铜甲，神情严肃，背景是开阔山地。',
    confidence: 'medium',
    _user_note: 'KB 把蕾雅误识别为莱娜——anchor 仍以镜头内容为准',
  },
  {
    scene_id: 's699',
    symbol_id: 'kingsguard_white_cloak_pin',
    evidence_in_frame: '克里斯顿·科尔低头坐在地上，双手紧握，脸上和手臂上可见伤痕——手中应有白斗篷别针特写（自尽未遂时刻）。',
    confidence: 'high',
  },
  {
    scene_id: 's435',
    symbol_id: 'daemon_does_not_rise',
    evidence_in_frame: '戴蒙王子坐在宴会厅餐桌旁，目光转向右侧，神情若有所思——周围人入场行礼时他端坐不动。',
    confidence: 'high',
  },
  {
    scene_id: 's268',
    symbol_id: 'parallel_walk_no_touch',
    evidence_in_frame: '雷尼拉公主与莱诺·瓦列利安在船上交谈，背景黄昏海景；两人保持一臂距离，从未接触。',
    confidence: 'high',
  },
  {
    scene_id: 's663',
    symbol_id: 'reaction_montage',
    evidence_in_frame: '婚宴大厅，殴杀事件已发生：地面血迹、人群退散或惊愕、新人处于震惊状态；蕾妮丝立于人群一侧静观。',
    confidence: 'high',
  },
  {
    scene_id: 's663',
    symbol_id: 'wedding_color_drop',
    evidence_in_frame: '同一空间在婚宴前后的色温骤变：从婚宴的暖金转为血案后的冷蓝灰，画面只剩稀疏火把。',
    confidence: 'medium',
  },
  {
    scene_id: 's690',
    symbol_id: 'cloaking_ritual',
    evidence_in_frame: '雷尼拉公主与莱诺·瓦列利安在神木林举行婚礼，新郎为新娘披上瓦列利安家族斗篷的"披纱礼"瞬间。',
    confidence: 'high',
  },
  {
    scene_id: 's331',
    symbol_id: 'kingsguard_vow_punishment',
    evidence_in_frame: '克里斯顿·科尔身着盔甲，面露痛苦绝望，向画面外人请求"仁慈地判处死刑"——违誓刑罚的具体台词。',
    confidence: 'high',
  },
  {
    scene_id: 's272',
    symbol_id: 'duck_goose_euphemism',
    evidence_in_frame: '雷尼拉公主与莱诺·瓦列利安在船上交谈，雷尼拉用"鸭肉/鹅肉"委婉表达她理解莱诺的性取向。',
    confidence: 'high',
  },
];

let added = 0;
let skipped = 0;
const issues = [];

for (const b of BINDINGS) {
  const scene = kb.scenes.find(s => s.scene_id === b.scene_id);
  if (!scene) {
    issues.push(`MISSING scene ${b.scene_id} for ${b.symbol_id}`);
    continue;
  }
  if (!scene.symbols) scene.symbols = [];
  const exists = scene.symbols.some(s => s.symbol_id === b.symbol_id);
  if (exists) {
    skipped++;
    issues.push(`already bound: ${b.scene_id} <- ${b.symbol_id}`);
    continue;
  }
  const entry = {
    symbol_id: b.symbol_id,
    evidence_in_frame: b.evidence_in_frame,
    confidence: b.confidence,
    source: 'user_seed_e5_2026-05-01',
  };
  if (b._user_note) entry._user_note = b._user_note;
  scene.symbols.push(entry);
  added++;
}

fs.writeFileSync(KB_PATH, JSON.stringify(kb, null, 2) + '\n', 'utf8');
console.log(`added: ${added}, skipped: ${skipped}`);
if (issues.length) console.log('issues:', issues);
