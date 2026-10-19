import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { DailyBrief } from "../types";

/**
 * 今日早报（行动层右栏：桌面与「数据」指标条左右分栏，先看人再看数）。
 * 名单是规则数据，永远可见；ai_note 是可选的一句话开场白（配额内才生成）。
 * 拉取失败静默隐藏——不阻断工作台其余模块；空态是正常状态，给出去人才库的出口。
 */
export default function DailyBrief() {
  const [data, setData] = useState<DailyBrief | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let alive = true;
    api.getDailyBrief()
      .then((r) => { if (alive) { setData(r); setState("ok"); } })
      .catch(() => { if (alive) setState("error"); });
    return () => { alive = false; };
  }, []);

  if (state !== "ok" || !data) return null;

  const dateText = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });

  return (
    <div className="wb-brief">
      <div className="wb-brief-head">
        <span className="wb-brief-title">今日早报</span>
        <span className="wb-brief-date">{dateText}</span>
      </div>

      {data.ai_note ? (
        <div className="wb-brief-note">
          <span className="wb-brief-ai-tag">AI 小结</span>
          <span>{data.ai_note}</span>
        </div>
      ) : null}

      {data.items.length === 0 ? (
        <div className="wb-brief-empty">
          <span className="wb-brief-empty-main">今天没有人等你</span>
          <Link to="/talents" className="wb-brief-empty-link">去人才库看看，有没有人匹配新岗位 →</Link>
        </div>
      ) : (
        <ul className="wb-brief-list">
          {data.items.map((it) => (
            <li key={it.link_key} className="wb-brief-item">
              <span className={`wb-brief-dot is-${it.level}`} />
              <Link to={`/talents/${it.talent_id}`} className="wb-brief-name">{it.talent_name}</Link>
              <span className="wb-brief-job">{it.job_title}</span>
              <span className="wb-brief-reason">{it.reason}</span>
              <span className="wb-brief-action">{it.action}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
