import React, { useEffect, useMemo, useRef, useState } from 'react';
import './RoleplayDialogueDE.css';

/* DE 风格的角色对谈底部叠层
 * - 顶左：玩家身份卡（默认雷尼拉）
 * - 底部 25-30vh：NPC 字幕 + 内心声音 + 3 立场选项 + 自由输入
 *
 * 与外部交互：
 *   <RoleplayDialogueDE
 *     character={npc}                           // {character_id, display_name, short_identity}
 *     messages={[{role,text,voices?,streaming?}]}
 *     sending                                   // 是否在等 NPC 回复
 *     onSubmit(text)                            // 玩家说了什么 → 触发下一轮 stream
 *     onExit()
 *     intro={{hero_line, sub_line}}             // 入场前奏（替代第一句 NPC 台词）
 *     introLoading
 *     choices={[{stance,text,skill_check}]}     // /api/agent/roleplay/choices 的结果
 *     choicesLoading
 *   />
 */

// 立场颜色映射（与 demo 对齐）
const STANCE_CLS = {
  '王者': 'stance-king',
  '审慎': 'stance-prudent',
  '血亲': 'stance-blood',
  '挑衅': 'stance-fire',
  '政治': 'stance-political',
  '火焰': 'stance-fire',
  '沉默': 'stance-silence',
};

// 难度颜色
const DIFF_CLS = {
  '简单': 'diff-easy',
  '中等': 'diff-medium',
  '困难': 'diff-hard',
};

// 内心声音映射到 CSS 修饰类
const VOICE_CLS = {
  LOGIC: 'skill-logic',
  EMPATHY: 'skill-empathy',
  AUTHORITY: 'skill-authority',
  VOLITION: 'skill-volition',
  SUGGESTION: 'skill-suggestion',
  COMPOSURE: 'skill-composure',
  PERCEPTION: 'skill-perception',
  'INLAND EMPIRE': 'skill-inland',
  'ESPRIT DE CORPS': 'skill-esprit',
};
const VOICE_LABEL = {
  LOGIC: '逻辑',
  EMPATHY: '共情',
  AUTHORITY: '权威',
  VOLITION: '意志',
  SUGGESTION: '暗示',
  COMPOSURE: '镇定',
  PERCEPTION: '感知',
  'INLAND EMPIRE': '内陆帝国',
  'ESPRIT DE CORPS': '群体感',
};

// 把 agent 文本里的内联 [TAG] 行剥掉，只留人物台词部分
function extractSpeech(text) {
  if (!text) return '';
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^[\[【]\s*[A-Z一-龥][A-Z一-龥\s]{0,19}\s*[\]】]/.test(l))
    .join(' ')
    .trim();
}

export default function RoleplayDialogueDE({
  character,
  messages,
  sending,
  onSubmit,
  onExit,
  onClear,
  intro,
  introLoading,
  choices = [],
  choicesLoading = false,
}) {
  const [freeInputOpen, setFreeInputOpen] = useState(false);
  const [freeInputValue, setFreeInputValue] = useState('');
  const [selectedKey, setSelectedKey] = useState(null);
  const freeInputRef = useRef(null);

  // 找最后一条 agent 消息（NPC 当前台词）
  const lastAgent = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'agent') return messages[i];
    }
    return null;
  }, [messages]);

  // NPC 台词：优先取 lastAgent.text；若还没有 NPC 回复则用 intro.hero_line（入场前奏）
  const isStreaming = !!lastAgent?.streaming;
  const npcSpeech = useMemo(() => {
    if (lastAgent) return extractSpeech(lastAgent.text || '');
    if (intro?.hero_line) return intro.hero_line;
    if (introLoading) return '';
    return '';
  }, [lastAgent, intro, introLoading]);

  const subSpeech = !lastAgent && intro?.sub_line ? intro.sub_line : null;

  // 玩家内心声音（来自 /roleplay/voices）
  const innerVoices = Array.isArray(lastAgent?.voices) ? lastAgent.voices : [];

  // 选项可用：必须 NPC 已经把话说完（!streaming），且 choicesLoading 完成
  const optionsReady = !isStreaming && !choicesLoading && choices.length > 0;

  function pickOption(opt, idx) {
    if (selectedKey != null) return;
    setSelectedKey(idx);
    // 200ms 金光闪烁后再 submit；其它选项已通过 has-selected 类淡到 30%
    setTimeout(() => {
      onSubmit(opt.text);
      setSelectedKey(null);
    }, 220);
  }

  function openFreeInput() {
    setFreeInputOpen(true);
    requestAnimationFrame(() => freeInputRef.current?.focus());
  }
  function closeFreeInput() {
    setFreeInputOpen(false);
    setFreeInputValue('');
  }
  function submitFree() {
    const text = freeInputValue.trim();
    if (!text) { closeFreeInput(); return; }
    onSubmit(text);
    closeFreeInput();
  }

  // 键盘：1-N 选项 / ENTER 自由输入 / ESC 收回输入或退出对谈
  useEffect(() => {
    const onKey = (e) => {
      if (freeInputOpen) {
        if (e.key === 'Escape') { closeFreeInput(); }
        // ENTER 由 input 自身的 onKeyDown 处理（避免 capture 阶段抢）
        return;
      }
      if (e.key === 'Escape') { onExit(); return; }
      if (sending || isStreaming || !optionsReady) {
        if (e.key === 'Enter') { openFreeInput(); }
        return;
      }
      const idx = parseInt(e.key, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= choices.length) {
        e.preventDefault();
        pickOption(choices[idx - 1], idx - 1);
      } else if (e.key === 'Enter') {
        openFreeInput();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [freeInputOpen, sending, isStreaming, optionsReady, choices, onExit]);

  // 关闭按钮（× 在右上角；和上下结构一致，独立处理）
  return (
    <div className="rpd-root" onClick={onExit}>
      {/* 极淡 vignette，让上下文字读起来不刺眼，但画面主体仍清晰 */}
      <div className="rpd-vignette" />

      {/* 左上玩家身份卡（默认雷尼拉） */}
      <aside className="rpd-id" onClick={(e) => e.stopPropagation()}>
        <div className="rpd-id-name">雷尼拉·坦格利安</div>
        <div className="rpd-id-line" />
        <div className="rpd-id-title">龙石岛公主 · 王座继承人</div>
      </aside>

      {/* 右上操作按钮组 */}
      {onClear && messages.length > 0 && (
        <button
          className="rpd-clear"
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          title="清空对话记录"
        >↺</button>
      )}
      <button
        className="rpd-close"
        onClick={(e) => { e.stopPropagation(); onExit(); }}
        title="ESC 离开"
      >×</button>

      {/* 底部叠层 —— 整块阻断 click，避免点字幕也意外退出 */}
      <div className="rpd-bottom" onClick={(e) => e.stopPropagation()}>

        {/* 3.1 NPC 字幕 */}
        {npcSpeech ? (
          <div className={`rpd-npc ${isStreaming ? 'is-streaming' : ''}`} key={lastAgent?.text?.length || 'intro'}>
            <span className="rpd-npc-name">
              {(character.display_name || '').toUpperCase()}
            </span>
            <span className="rpd-npc-dash">—</span>
            <span className="rpd-npc-text">"{npcSpeech}"</span>
          </div>
        ) : introLoading ? (
          <div className="rpd-npc rpd-npc-loading">
            <span className="rpd-npc-name">{(character.display_name || '').toUpperCase()}</span>
            <span className="rpd-npc-dash">—</span>
            <span className="rpd-npc-text">…</span>
          </div>
        ) : null}

        {/* sub_line（入场副线）作为一行衬线斜体淡灰，仅 intro 阶段出现 */}
        {subSpeech && (
          <div className="rpd-sub-line">{subSpeech}</div>
        )}

        {/* 3.2 内心声音（剧本控制；不是每次都出现） */}
        {innerVoices.length > 0 && (
          <div className="rpd-inner-stack">
            {innerVoices.slice(0, 3).map((v, i) => {
              const cls = VOICE_CLS[v.voice] || 'skill-empathy';
              const label = VOICE_LABEL[v.voice] || v.voice;
              return (
                <div className={`rpd-inner ${cls}`} key={i}>
                  <span className="rpd-inner-skill">{label}</span>
                  <span className="rpd-inner-dash">—</span>
                  <span className="rpd-inner-text">{v.text}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* 3.3 玩家选项 */}
        {(choicesLoading || isStreaming) && (
          <div className="rpd-options-loading">
            {isStreaming ? '…' : '正在拟出回应 ……'}
          </div>
        )}
        {!choicesLoading && !isStreaming && (
          <ol className={`rpd-options ${selectedKey != null ? 'has-selected' : ''} ${!optionsReady ? 'is-disabled' : ''}`}>
            {choices.map((opt, i) => {
              const stanceCls = STANCE_CLS[opt.stance] || 'stance-prudent';
              const diffCls = opt.skill_check ? (DIFF_CLS[opt.skill_check.difficulty] || '') : '';
              const isSilence = opt.stance === '沉默';
              return (
                <li
                  key={i}
                  className={`rpd-option ${stanceCls} ${diffCls} ${selectedKey === i ? 'is-selected' : ''}`}
                  onClick={() => pickOption(opt, i)}
                >
                  <span className={`rpd-text ${isSilence ? 'is-silence' : ''}`}>
                    {opt.text}
                  </span>
                  {opt.skill_check && (
                    <span className="rpd-check">
                      <span className="rpd-skill-num">
                        {opt.skill_check.skill} {opt.skill_check.value}
                      </span>
                      <span className="rpd-difficulty">{opt.skill_check.difficulty}</span>
                    </span>
                  )}
                </li>
              );
            })}
            <li
              className="rpd-option free"
              onClick={openFreeInput}
            >
              <span className="rpd-text-free">自由输入</span>
            </li>
          </ol>
        )}

        {/* 自由输入展开行 */}
        {freeInputOpen && (
          <div className="rpd-free-row">
            <span className="rpd-prompt">YOU</span>
            <input
              ref={freeInputRef}
              type="text"
              autoComplete="off"
              placeholder="自己开口……"
              value={freeInputValue}
              onChange={(e) => setFreeInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submitFree(); }
                else if (e.key === 'Escape') { e.preventDefault(); closeFreeInput(); }
              }}
            />
            <span className="rpd-hint">ENTER 说出 · ESC 收回</span>
          </div>
        )}
      </div>

      {/* 角落小提示 */}
      <div className="rpd-kbd">ENTER 自由输入 · ESC 离开</div>
    </div>
  );
}
