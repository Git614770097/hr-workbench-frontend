import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import type { Talent, Tag } from "../types";
import { STATUS_LABELS, STATUS_COLORS } from "../types";

export default function TalentList() {
  const navigate = useNavigate();
  const [talents, setTalents] = useState<Talent[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [cityFilter, setCityFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");

  const fetchTalents = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, limit: 20 };
      if (query) params.q = query;
      if (statusFilter) params.status = statusFilter;
      if (cityFilter) params.city = cityFilter;
      if (tagFilter) params.tag_id = tagFilter;

      const res = await api.getTalents(params);
      setTalents(res.items);
      setTotal(res.total);
      setPages(res.pages);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, [page, query, statusFilter, cityFilter, tagFilter]);

  const fetchTags = async () => {
    try {
      const res = await api.getTags();
      setTags(res);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchTalents();
  }, [fetchTalents]);

  useEffect(() => {
    fetchTags();
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchTalents();
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确认删除人才「${name}」？此操作不可撤销。`)) return;
    try {
      await api.deleteTalent(id);
      fetchTalents();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>人才库</h1>
        <button className="btn-primary" onClick={() => navigate("/talents/new")}>
          + 新增人才
        </button>
      </div>

      <form className="filter-bar" onSubmit={handleSearch}>
        <input
          className="search-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索姓名、公司、职位、技能、备注…"
        />
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
        >
          <option value="">全部状态</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <input
          type="text"
          value={cityFilter}
          onChange={(e) => { setCityFilter(e.target.value); setPage(1); }}
          placeholder="城市"
          className="filter-city"
        />
        <select
          value={tagFilter}
          onChange={(e) => { setTagFilter(e.target.value); setPage(1); }}
        >
          <option value="">全部标签</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <button type="submit" className="btn-secondary">搜索</button>
      </form>

      <div className="stat-row">
        <span className="stat-item">共 <strong>{total}</strong> 位人才</span>
      </div>

      {loading ? (
        <div className="loading">加载中…</div>
      ) : talents.length === 0 ? (
        <div className="empty-state">
          <p>暂无人才数据</p>
          <button className="btn-primary" onClick={() => navigate("/talents/new")}>
            添加第一位人才
          </button>
        </div>
      ) : (
        <>
          <div className="talent-grid">
            {talents.map((t) => (
              <div key={t.id} className="talent-card">
                <div className="talent-card-header">
                  <Link to={`/talents/${t.id}`} className="talent-name">{t.name}</Link>
                  <span className="status-badge" style={{ background: STATUS_COLORS[t.status] || "#999" }}>
                    {STATUS_LABELS[t.status] || t.status}
                  </span>
                </div>
                <div className="talent-card-body">
                  {t.current_title && (
                    <div className="talent-field"><span className="field-label">职位</span><span>{t.current_title}</span></div>
                  )}
                  {t.current_company && (
                    <div className="talent-field"><span className="field-label">公司</span><span>{t.current_company}</span></div>
                  )}
                  {t.city && (
                    <div className="talent-field"><span className="field-label">城市</span><span>{t.city}</span></div>
                  )}
                  {t.years_experience != null && (
                    <div className="talent-field"><span className="field-label">年限</span><span>{t.years_experience}年</span></div>
                  )}
                  {t.skills.length > 0 && (
                    <div className="talent-skills">
                      {t.skills.slice(0, 5).map((s, i) => (
                        <span key={i} className="skill-chip">{s}</span>
                      ))}
                      {t.skills.length > 5 && (
                        <span className="skill-chip more">+{t.skills.length - 5}</span>
                      )}
                    </div>
                  )}
                  {t.tags.length > 0 && (
                    <div className="talent-tags">
                      {t.tags.map((tag) => (
                        <span key={tag.id} className="tag-chip"
                          style={{ background: tag.color + "20", color: tag.color, borderColor: tag.color }}
                        >{tag.name}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="talent-card-footer">
                  <Link to={`/talents/${t.id}`} className="btn-link">查看</Link>
                  <Link to={`/talents/${t.id}/edit`} className="btn-link">编辑</Link>
                  <button className="btn-link danger" onClick={() => handleDelete(t.id, t.name)}>删除</button>
                </div>
              </div>
            ))}
          </div>

          {pages > 1 && (
            <div className="pagination">
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="btn-page">上一页</button>
              <span className="page-info">{page} / {pages}</span>
              <button disabled={page >= pages} onClick={() => setPage(page + 1)} className="btn-page">下一页</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
