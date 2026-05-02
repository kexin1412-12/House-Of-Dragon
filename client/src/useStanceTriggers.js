import { useEffect, useRef, useState } from 'react';
import { isTriggerHandled, getChoiceFor, getOptIn } from './stanceStore';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

// 拉指定 video 的 stance triggers，并监听 currentTime —— 越过某个 trigger 的
// timestamp 时（且尚未触发过、且用户已 opt-in）就 setActive(trigger)，由父组件
// 暂停视频 + 弹 StanceCard。
//
// 触发窗口：[ts, ts + 2.5s)。这比 branch_points 那 1.5s 略宽 —— 立场卡更重，
// 给 timeupdate event loop 更宽容的对齐时间，避免 seek 后错过窗口。
//
// 模式：
//   - faction_choice：到 timestamp 直接弹
//   - recall：到 timestamp 时再检查 requires_prior_choice 是否存在，存在才弹
//
// 返回：{ activeTrigger, priorChoice, dismiss, resolve, reload, allTriggers, optIn, setOptIn, refresh }

const TRIGGER_WINDOW_SECONDS = 2.5;

export default function useStanceTriggers({ videoId, videoRef, enabled = true }) {
  const [allTriggers, setAllTriggers] = useState([]);
  const [activeTrigger, setActiveTrigger] = useState(null);
  const [priorChoice, setPriorChoice] = useState(null);
  const [optInState, setOptInState] = useState(getOptIn());
  const [bumpTick, setBumpTick] = useState(0);  // 用于 reload state 后重新计算

  const firedThisSessionRef = useRef(new Set());

  // 拉触发点配置
  useEffect(() => {
    if (!videoId) { setAllTriggers([]); return; }
    let cancelled = false;
    fetch(`${API}/api/stance/triggers?videoId=${encodeURIComponent(videoId)}`)
      .then(r => r.ok ? r.json() : { triggers: [] })
      .then(data => {
        if (cancelled) return;
        setAllTriggers(Array.isArray(data?.triggers) ? data.triggers : []);
      })
      .catch(() => { if (!cancelled) setAllTriggers([]); });
    return () => { cancelled = true; };
  }, [videoId]);

  // 切视频时重置 in-session fired set + active state
  useEffect(() => {
    firedThisSessionRef.current = new Set();
    setActiveTrigger(null);
    setPriorChoice(null);
  }, [videoId]);

  // 监听 currentTime
  useEffect(() => {
    const v = videoRef?.current;
    if (!v || !enabled || allTriggers.length === 0) return;

    const onTime = () => {
      // 已经在显示一张卡 → 不叠加
      if (activeTrigger) return;
      // opt-in 状态 'no' → 整轮不触发；'yes' 或 null 都允许（null 时父组件会先弹 opt-in）
      if (optInState === 'no') return;

      const now = v.currentTime;
      for (const tg of allTriggers) {
        if (firedThisSessionRef.current.has(tg.trigger_id)) continue;
        if (isTriggerHandled(tg.trigger_id)) continue;
        if (now < tg.timestamp) continue;
        if (now >= tg.timestamp + TRIGGER_WINDOW_SECONDS) {
          // 窗口已过 —— 标记为本会话不再触发，避免视频后段反复检查
          firedThisSessionRef.current.add(tg.trigger_id);
          continue;
        }

        // recall 类型：需要前置选择存在
        if (tg.type === 'recall') {
          const prior = tg.requires_prior_choice
            ? getChoiceFor(tg.requires_prior_choice)
            : null;
          if (!prior) {
            firedThisSessionRef.current.add(tg.trigger_id);
            continue;
          }
          firedThisSessionRef.current.add(tg.trigger_id);
          setPriorChoice(prior);
          setActiveTrigger(tg);
          return;
        }

        // faction_choice：直接触发
        firedThisSessionRef.current.add(tg.trigger_id);
        setPriorChoice(null);
        setActiveTrigger(tg);
        return;
      }
    };

    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [allTriggers, activeTrigger, enabled, optInState, videoRef, bumpTick]);

  // 暴露：清掉当前激活、强制重新拉 opt-in 状态
  function dismiss() {
    setActiveTrigger(null);
    setPriorChoice(null);
  }
  function refresh() {
    setOptInState(getOptIn());
    setBumpTick(t => t + 1);
  }

  return {
    allTriggers,
    activeTrigger,
    priorChoice,
    optIn: optInState,
    dismiss,
    refresh,
  };
}
