import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "antd";
import { CloseOutlined, ArrowRightOutlined, ArrowLeftOutlined, CheckOutlined } from "@ant-design/icons";
import { openOnbForm, fillOnbForm } from "./onboardingAutoFill";
import "../styles/onboarding.css";

export interface OnbStep {
  /** 高亮目标元素的 CSS 选择器；不传则居中展示（用于开场/收尾） */
  target?: string;
  /** 居中展示 */
  center?: boolean;
  title: string;
  desc: string;
  /** 底部「去体验」按钮的跳转地址 */
  goTo?: string;
  goToLabel?: string;
  /** 动手任务：必须真实点中某个按钮才算完成 */
  action?: {
    target: string;
    label: string;
    name?: string;
  };
}

interface Props {
  steps: OnbStep[];
  open: boolean;
  onClose: (finished?: boolean) => void;
  onNavigate?: (path: string) => void;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * 轻量新手指引：全屏遮罩挖洞高亮 + 气泡讲解。
 * 定位基于 getBoundingClientRect，随滚动/resize/路由变化重算。
 */
export default function Onboarding({ steps, open, onClose, onNavigate }: Props) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [tick, setTick] = useState(0);
  // 动手任务状态：waiting=已引导去填，done=保存成功，missing=压根找不到这个入口
  const [waiting, setWaiting] = useState(false);
  const [done, setDone] = useState(false);
  const [missing, setMissing] = useState(false);
  // armed=已在动手步骤触发代填、等待保存事件（用 ref 避免闭包过期）
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);

  const step = steps[index];
  const isLast = index >= steps.length - 1;
  const action = step?.action;

  // 切换步骤时清空动手任务的中间状态
  useEffect(() => {
    setWaiting(false);
    setDone(false);
    setMissing(false);
    setArmed(false);
    armedRef.current = false;
  }, [index, open]);

  const measure = () => {
    if (!open || !step) return;
    if (step.center || !step.target) {
      setRect(null);
      return;
    }
    const el = document.querySelector(step.target) as HTMLElement | null;
    if (!el) {
      // 目标不存在（权限过滤 / 该页未渲染此元素）：退化为居中卡片，不卡流程
      setRect(null);
      if (step.action) setMissing(true);
      return;
    }
    if (step.action) setMissing(false);
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    if (r.top < 90 || r.bottom > window.innerHeight - 90) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };

  useLayoutEffect(measure, [open, index, tick, step]);

  // 重算节流：滚动/resize 用 rAF 合并，避免高频 setState
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 动手任务完成判定：不再依赖「点中某个按钮」，而是由业务页在「保存成功」后
  // 广播 onb:record-saved。引导只负责帮用户填好表单，用户点「保存」即算完成，
  // 随后自动进入下一步。armedRef 保证只有已触发代填的当前步骤才会响应。
  useEffect(() => {
    if (!open) return;
    const onSaved = () => {
      if (armedRef.current && step?.action) setDone(true);
    };
    window.addEventListener("onb:record-saved", onSaved);
    return () => window.removeEventListener("onb:record-saved", onSaved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index]);

  // 点中之后给一点正反馈再自动进下一步，别让用户怀疑点没点上
  useEffect(() => {
    if (!open || !done) return;
    const t = window.setTimeout(() => {
      if (isLast) onClose(true);
      else setIndex((i) => i + 1);
    }, 1700);
    return () => window.clearTimeout(t);
  }, [done, open, isLast, onClose]);

  // 键盘：Esc 结束，← → 切换
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose(false);
      } else if (e.key === "ArrowRight") {
        setIndex((i) => Math.min(i + 1, steps.length - 1));
      } else if (e.key === "ArrowLeft") {
        setIndex((i) => Math.max(i - 1, 0));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, steps.length]);

  // 气泡实际高度：任务条会让气泡变高，硬编码会把气泡顶出视口，所以实测
  // ⚠️ 这三个 Hook 必须放在 `if (!open || !step) return null` 之前：
  // 否则 open 从 false→true（引导弹出）时 Hook 数量会变，React 直接崩溃白屏。
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipH, setTipH] = useState(240);
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (el) {
      const h = el.offsetHeight;
      if (h > 0) setTipH(h);
    }
  }, [index, tick, missing, done, waiting, open, step]);

  // 进入带 goTo 的步骤时自动跳转：动手任务页先跳再自动打开空表单，
  // 其余页直接跳（不再要求点「去看看」）。目标页需 mount 并向 onboardingAutoFill
  // 登记 open/fill 处理器；open 调用若页面未就绪会被排队，登记后自动 flush。
  // ⚠️ 必须放在 return null 之前，否则 open 为 false 时此 Hook 不执行，
  //    与 open 为 true 时的 Hook 数量不一致 → React 崩溃白屏。
  useEffect(() => {
    if (!open || !step) return;
    if (step.goTo && window.location.pathname !== step.goTo) {
      onNavigate?.(step.goTo);
    }
    if (step.action && step.goTo) {
      // 自动弹出空的新建表单，等用户点「帮我填好表单」填示例数据
      openOnbForm(step.goTo);
      setArmed(true);
      armedRef.current = true;
    }
    // 路由切换后页面才渲染，延迟一下再重新测量高亮位置（measure 依赖 tick）
    const t = window.setTimeout(() => setTick((n) => n + 1), 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, open]);

  if (!open || !step) return null;

  const goNext = () => {
    if (isLast) {
      onClose(true);
      return;
    }
    setIndex((i) => i + 1);
  };

  const goPrev = () => setIndex((i) => Math.max(i - 1, 0));

  // 动手任务：点「帮我填好表单」把示例数据写进已打开的表单；保存成功即判完成
  const fillAction = () => {
    if (step?.goTo) fillOnbForm(step.goTo);
    setWaiting(true);
    setArmed(true);
    armedRef.current = true;
    setTick((t) => t + 1);
  };

  // 气泡定位：右侧优先，其次左侧，再次下方；窄屏固定底部
  const placeTip = (): React.CSSProperties => {
    const vw = window.innerWidth;
    const W = 312;
    const H = tipH;
    const gap = 14;
    if (vw < 720 || !rect) {
      return { left: 12, right: 12, top: "auto", bottom: 12, transform: "none" };
    }
    if (rect.left + rect.width + gap + W <= vw - 10) {
      return { left: rect.left + rect.width + gap, top: rect.top + rect.height / 2, transform: "translateY(-50%)" };
    }
    if (rect.left - gap - W >= 10) {
      return { left: rect.left - gap - W, top: rect.top + rect.height / 2, transform: "translateY(-50%)" };
    }
    if (rect.top + rect.height + gap + H <= window.innerHeight - 10) {
      return { left: rect.left + rect.width / 2, top: rect.top + rect.height + gap, transform: "translateX(-50%)" };
    }
    return { left: rect.left + rect.width / 2, top: Math.max(10, rect.top - H - gap), transform: "translateX(-50%)" };
  };

  return createPortal(
    <div className="obo-root">
      {rect && !step.center && (
        <div
          className={`obo-hole ${step.action && !done ? "is-action" : ""}`}
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
        />
      )}

      <div className="obo-tip" style={placeTip()} ref={tipRef}>
        <div className="obo-head">
          <span className="obo-step-count">
            第 {index + 1} / {steps.length} 步
          </span>
          <button type="button" className="obo-close" onClick={() => onClose(false)} title="跳过引导">
            <CloseOutlined />
          </button>
        </div>

        <div className="obo-title">{step.title}</div>
        <div className="obo-desc">{step.desc}</div>

        {action ? (
          <div className={`obo-do ${done ? "is-done" : waiting ? "is-waiting" : ""}`}>
            {done ? (
              <>
                <span className="obo-do-check">✓</span>
                <span>做得好，已记下。马上进入下一步…</span>
              </>
            ) : waiting && missing ? (
              <>
                <span className="obo-do-icon">·</span>
                <span>
                  页面上没找到「{action.name || "这个按钮"}」，可能是权限限制，直接点「下一步」跳过即可。
                </span>
              </>
            ) : waiting ? (
              <>
                <span className="obo-do-icon">→</span>
                <span>示例已填好，点「保存」即可；保存成功会自动进入下一步。</span>
              </>
            ) : (
              <>
                <span className="obo-do-icon">👉</span>
                <span>点「帮我填好表单」自动填好示例数据，再点「保存」即可。</span>
              </>
            )}
          </div>
        ) : null}

        <div className="obo-foot">
          {index > 0 ? (
            <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={goPrev}>
              上一步
            </Button>
          ) : (
            <span />
          )}
          <div className="obo-actions">
            {action && !done ? (
              waiting ? (
                <Button size="small" onClick={fillAction}>
                  重新填报
                </Button>
              ) : (
                <Button size="small" type="primary" onClick={fillAction}>
                  帮我填好表单
                </Button>
              )
            ) : null}
            <Button
              type="primary"
              size="small"
              icon={isLast ? <CheckOutlined /> : <ArrowRightOutlined />}
              onClick={goNext}
            >
              {index === 0 ? "开始练习" : isLast ? "开始使用" : "下一步"}
            </Button>
          </div>
        </div>

        <div className="obo-dots">
          {steps.map((s, i) => (
            <span key={i} className={`obo-dot ${i === index ? "active" : ""} ${i < index ? "done" : ""}`} />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
