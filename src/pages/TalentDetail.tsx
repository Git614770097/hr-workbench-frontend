import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api } from "../api";
import type { Talent, Communication } from "../types";
import { STATUS_LABELS, STATUS_COLORS, COMM_TYPES } from "../types";

export default function TalentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [talent, setTalent] = useState<Talent | null>(null);
  const [comms, setComms] = useState<Communication[]>([]);
  const [loading, setLoading] = useState(true);

  const [showCommForm, setShowCommForm] = useState(false);
  const [commType, setCommType] = useState("call");
  const [commContent, setCommContent] = useState("");
  const [commRating, setCommRating] = useState(0);
  const [commFollowUp, setCommFollowUp] = useState("");

  const fetchData = async () => {
    if (!id) return;
    try {
      const [t, c] = await Promise.all([api.getTalent(id), api.getCommunications(id)]);
      setTalent(t);
      setComms(c);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, [id]);

  const handleAddComm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    try {
      await api.createCommunication({
        talent_id: id, type: commType, content: commContent,
        rating: commRating || undefined, follow_up_date: commFollowUp || undefined,
      });
      setShowCommForm(false);
      setCommContent(""); setCommRating(0); setCommFollowUp("");
      fetchData();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const handleDeleteComm = async (commId: string) => {
    if (!confirm("确认删除此沟通记录？")) return;
    try {
      await api.deleteCommunication(commId);
      fetchData();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const handleDeleteTalent = async () => {
    if (!talent) return;
    if (!confirm(`确认删除人才「${talent.name}」？所有关联数据将被清除。`)) return;
    try {
      await api.deleteTalent(talent.id);
      navigate("/talents");
    } catch (err) {
      alert((err as Error).message);
    }
  };

  if (loading) return <div className="loading">加载中…</div>;
  if (!talent) return <div className="empty-state">人才不存在</div>;

  return (
    <div className="page">
      <div className="page-header">
        <div className="detail-title">
          <Link to="/talents" className="back-link">← 人才库</Link>
          <h1>{talent.name}</h1>
          <span className="status-badge" style={{ background: STATUS_COLORS[talent.status] || "#999" }}>
            {STATUS_LABELS[talent.status] || talent.status}
          </span>
        </div>
        <div className="page-actions">
          <Link to={`/talents/${talent.id}/edit`} className="btn-secondary">编辑</Link>
          <button className="btn-danger" onClick={handleDeleteTalent}>删除</button>
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-left">
          <div className="detail-card">
            <h2>基本信息</h2>
            <div className="detail-fields">
              <div className="detail-field"><span className="field-label">当前公司</span><span className="field-value">{talent.current_company || "—"}</span></div>
              <div className="detail-field"><span className="field-label">当前职位</span><span className="field-value">{talent.current_title || "—"}</span></div>
              <div className="detail-field"><span className="field-label">工作年限</span><span className="field-value">{talent.years_experience != null ? `${talent.years_experience}年` : "—"}</span></div>
              <div className="detail-field"><span className="field-label">所在城市</span><span className="field-value">{talent.city || "—"}</span></div>
              <div className="detail-field"><span className="field-label">行业</span><span className="field-value">{talent.industry || "—"}</span></div>
              <div className="detail-field"><span className="field-label">电话</span><span className="field-value">{talent.phone || "—"}</span></div>
              <div className="detail-field"><span className="field-label">邮箱</span><span className="field-value">{talent.email || "—"}</span></div>
              <div className="detail-field"><span className="field-label">期望薪资</span><span className="field-value">{talent.expected_salary || "—"}</span></div>
              <div className="detail-field"><span className="field-label">期望城市</span><span className="field-value">{talent.expected_city || "—"}</span></div>
            </div>
          </div>

          {talent.skills.length > 0 && (
            <div className="detail-card">
              <h2>技能标签</h2>
              <div className="talent-skills">
                {talent.skills.map((s, i) => (<span key={i} className="skill-chip">{s}</span>))}
              </div>
            </div>
          )}

          {talent.tags.length > 0 && (
            <div className="detail-card">
              <h2>自定义标签</h2>
              <div className="talent-tags">
                {talent.tags.map((tag) => (
                  <span key={tag.id} className="tag-chip"
                    style={{ background: tag.color + "20", color: tag.color, borderColor: tag.color }}
                  >{tag.name}</span>
                ))}
              </div>
            </div>
          )}

          {talent.notes && (
            <div className="detail-card">
              <h2>备注</h2>
              <p className="detail-notes">{talent.notes}</p>
            </div>
          )}
        </div>

        <div className="detail-right">
          <div className="detail-card">
            <div className="card-header-row">
              <h2>沟通记录</h2>
              <button className="btn-sm-primary" onClick={() => setShowCommForm(!showCommForm)}>
                {showCommForm ? "取消" : "+ 添加记录"}
              </button>
            </div>

            {showCommForm && (
              <form className="comm-form" onSubmit={handleAddComm}>
                <div className="form-row">
                  <label>类型</label>
                  <select value={commType} onChange={(e) => setCommType(e.target.value)}>
                    {Object.entries(COMM_TYPES).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
                  </select>
                </div>
                <div className="form-row">
                  <label>评分 (1-5)</label>
                  <select value={commRating} onChange={(e) => setCommRating(Number(e.target.value))}>
                    <option value={0}>不评分</option>
                    {[1, 2, 3, 4, 5].map((n) => (<option key={n} value={n}>{"⭐".repeat(n)}</option>))}
                  </select>
                </div>
                <div className="form-row">
                  <label>跟进提醒日期</label>
                  <input type="date" value={commFollowUp} onChange={(e) => setCommFollowUp(e.target.value)} />
                </div>
                <div className="form-row">
                  <label>沟通内容</label>
                  <textarea value={commContent} onChange={(e) => setCommContent(e.target.value)} placeholder="记录沟通要点…" rows={3} />
                </div>
                <button type="submit" className="btn-primary">保存记录</button>
              </form>
            )}

            {comms.length === 0 ? (
              <p className="empty-text">暂无沟通记录</p>
            ) : (
              <div className="comm-list">
                {comms.map((comm) => (
                  <div key={comm.id} className="comm-item">
                    <div className="comm-header">
                      <span className="comm-type">{COMM_TYPES[comm.type] || comm.type}</span>
                      {comm.rating != null && comm.rating > 0 && (
                        <span className="comm-rating">{"⭐".repeat(comm.rating)}</span>
                      )}
                      <span className="comm-date">{new Date(comm.created_at).toLocaleString("zh-CN")}</span>
                      <button className="btn-link danger sm" onClick={() => handleDeleteComm(comm.id)}>删除</button>
                    </div>
                    {comm.content && <p className="comm-content">{comm.content}</p>}
                    {comm.follow_up_date && (
                      <div className="comm-followup">📅 跟进提醒：{comm.follow_up_date}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
