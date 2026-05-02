import { useEffect, useRef, useState } from 'react';
import { isTriggerHandled, getChoiceFor } from './stanceStore';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

// 拉指定 video 的 stance triggers，并监听 currentTime —— 越过某个 trigger 的
// timestamp 时（且 enabled、且尚未触发过）就 setActive(trigger)，由父组件
// 弹 inline StanceCard。**不暂停视频** —— 卡片是不打断观影的小角浮层。
//
// 触发窗口：[ts, ts + 2.5s)。卡片显示后会一直挂到用户操作或父组件 timeout。
//
// 模式：
//   - faction_choice：到 timestamp 直接弹
//   - recall：到 timestamp 时再检查 requires_prior_choice 是否存在，存在才弹

const TRIGGER_WINDOW_SECONDS = 2.5;

export default function useStanceTriggers({ videoId, videoRef, enabled = true }) {
  const [allTriggers, setAllTriggers] = useState([]);
  const [activeTrigger, setActiveTrigger] = useState(null);
  const [priorChoice, setPriorChoice] = useState(null);

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

  // enabled 关掉时立刻收掉当前激活的卡（避免共谋开关关掉后卡还挂着）
  useEffect(() => {
    if (!enabled) {
      setActiveTrigger(null);
      setPriorChoice(null);
    }
  }, [enabled]);

  // 监听 currentTime
  useEffect(() => {
    const v = videoRef?.current;
    if (!v || !enabled || allTriggers.length === 0) return;

    const onTime = () => {
      if (activeTrigger) return;  // 已经在显示一张卡 → 不叠加

      const now = v.currentTime;
      for (const tg of allTriggers) {
        if (firedThisSessionRef.current.has(tg.trigger_id)) continue;
        if (isTriggerHandled(tg.trigger_id)) continue;
        if (now < tg.timestamp) continue;
        if (now >= tg.timestamp + TRIGGER_WINDOW_SECONDS) {
          firedThisSessionRef.current.add(tg.trigger_id);
          continue;
        }

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

        firedThisSessionRef.current.add(tg.trigger_id);
        setPriorChoice(null);
        setActiveTrigger(tg);
        return;
      }
    };

    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [allTriggers, activeTrigger, enabled, videoRef]);

  function dismiss() {
    setActiveTrigger(null);
    setPriorChoice(null);
  }

  // 从外部（叙事 X 光的脉络图标记）手动打开一张卡。覆盖当前激活的卡。
  function openManually(triggerId) {
    const tg = allTriggers.find(t => t.trigger_id === triggerId);
    if (!tg) return;
    if (tg.type === 'recall' && tg.requires_prior_choice) {
      setPriorChoice(getChoiceFor(tg.requires_prior_choice));
    } else {
      setPriorChoice(null);
    }
    setActiveTrigger(tg);
  }

  return {
    allTriggers,
    activeTrigger,
    priorChoice,
    dismiss,
    openManually,
  };
}
