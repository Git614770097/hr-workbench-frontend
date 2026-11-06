import { Tooltip } from "antd";
import { Link } from "react-router-dom";
import dayjs from "dayjs";
import type { Talent } from "../types";
import { STAGE_META } from "../types";

/**
 * 人才库列表的三个「决策列」单元格。
 *
 * 为什么单独抽一个文件：原来的列 render 全是 `v || "-"` 的字段直出，
 * 表格只回答「他是谁」；改版后每列都要带一点判断（阶段走到哪、下一步什么时候、
 * 该不该现在联系），逻辑塞进 TalentList.tsx 会让那个文件更难读。
 * 这里只做展示，不取数——用到的字段列表接口已经全部返回（t.*）。
 */

// 正向流程轨道：只放「能往前走」的五步。
// talents.stage 的取值与它对齐（见 worker/talentFlow.ts syncTalentStage），
// 终态不在这条轨道上：淘汰/放弃会被归并成 archived。
const TRACK = ["screening", "interview1", "interview2", "offer", "hired"] as const;

/** 名字 → 色相：同一个人每次进来颜色一致，不用存库也不用随机 */
function hueOf(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) || 0)) % 360;
  return h;
}

/** 候选人：首字头像 + 姓名 + 简历/标签 chips + 公司·职位·城市·年限副标题 */
export function CandidateCell({ t }: { t: Talent }) {
  const name = (t.name || "").trim();
  const hue = hueOf(name || "?");
  const tags = t.tags || [];
  const sub = [
    t.current_company,
    t.current_title,
    t.city,
    t.years_experience != null ? `${t.years_experience}年` : "",
  ].filter(Boolean).join(" · ");

  return (
    <div className="tl-cand">
      <div
        className="tl-avatar"
        style={{ background: `hsl(${hue} 68% 94%)`, color: `hsl(${hue} 42% 36%)` }}
        aria-hidden
      >
        {name.slice(0, 1) || "?"}
      </div>
      <div className="tl-cand-body">
        <div className="tl-cand-line">
          <Link to={`/talents/${t.id}`} className="tl-cand-name">{name || "未命名"}</Link>
          {t.has_resume && <span className="tl-chip tl-chip-resume">简历</span>}
          {tags.slice(0, 2).map((tag) => (
            <span key={tag} className="tl-chip">{tag}</span>
          ))}
          {tags.length > 2 && (
            <Tooltip title={tags.join("、")}>
              <span className="tl-chip tl-chip-more">+{tags.length - 2}</span>
            </Tooltip>
          )}
        </div>
        <div className="tl-cand-sub">
          {sub || <span className="tl-empty">未填写公司 / 职位</span>}
        </div>
      </div>
    </div>
  );
}

/** 流程阶段：五点进度 + 文字（双编码，扫视时不用逐字读） */
export function StageProgress({ stage }: { stage: string | null | undefined }) {
  const key = stage || "";
  // new 是表默认值，表示「录进来了但还没进任何岗位流程」——不是阶段，别画成第一格
  if (!key || key === "new") return <span className="tl-empty">未进流程</span>;
  if (key === "archived") return <span className="tl-empty">已结束</span>;

  const idx = (TRACK as readonly string[]).indexOf(key);
  const meta = STAGE_META[key];
  if (idx < 0 || !meta) return <span className="tl-empty">{meta?.label || key}</span>;

  return (
    <Tooltip title={`流程：${TRACK.map((k) => STAGE_META[k]?.label || k).join(" → ")}`}>
      <div className="tl-stage">
        <div className="tl-stage-track" aria-hidden>
          {TRACK.map((k, i) => (
            <span
              key={k}
              className={
                "tl-stage-dot"
                + (i < idx ? " is-done" : "")
                + (i === idx ? " is-current" : "")
              }
              style={
                i < idx
                  ? { background: meta.color }
                  : i === idx
                    ? { background: meta.color, boxShadow: `0 0 0 3px ${meta.bg}` }
                    : undefined
              }
            />
          ))}
        </div>
        <span className="tl-stage-label" style={{ color: meta.color }}>{meta.label}</span>
      </div>
    </Tooltip>
  );
}

/**
 * 下一步：只把「已经该做而没做」的染红。
 * 全页只有这一列允许抢注意力，所以颜色规则写死在这里，不开放给调用方传。
 */
export function NextStepCell({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="tl-empty">未安排</span>;
  const raw = String(value).slice(0, 10);
  const d = dayjs(raw);
  if (!d.isValid()) return <span className="tl-empty">未安排</span>;

  const diff = d.startOf("day").diff(dayjs().startOf("day"), "day");
  let tone = "is-future";
  let text = `${diff} 天后`;
  if (diff < 0) {
    tone = "is-overdue";
    text = `逾期 ${-diff} 天`;
  } else if (diff === 0) {
    tone = "is-today";
    text = "今天";
  } else if (diff === 1) {
    tone = "is-today";
    text = "明天";
  }

  return (
    <Tooltip title={`计划跟进：${d.format("YYYY-MM-DD")}`}>
      <span className={`tl-next ${tone}`}>
        {text}
        <em>{d.format("MM-DD")}</em>
      </span>
    </Tooltip>
  );
}

/** 最近更新：相对时间，超过 30 天只显示日期（「86 天前」不如日期好定位） */
export function UpdatedCell({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="tl-empty">-</span>;
  const d = dayjs(String(value).replace(" ", "T"));
  if (!d.isValid()) return <span className="tl-empty">-</span>;
  const days = dayjs().startOf("day").diff(d.startOf("day"), "day");
  if (days <= 0) return <span className="tl-updated">今天</span>;
  if (days > 30) return <span className="tl-updated">{d.format("YYYY-MM-DD")}</span>;
  return <span className="tl-updated">{days} 天前</span>;
}
