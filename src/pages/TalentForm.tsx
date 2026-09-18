import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import type { Talent, Tag } from "../types";
import { STATUS_LABELS } from "../types";

export default function TalentForm() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  const [form, setForm] = useState({
    name: "", phone: "", email: "", current_company: "", current_title: "",
    years_experience: "", city: "", skills: "", industry: "",
    expected_salary: "", expected_city: "", status: "active", notes: "",
  });

  useEffect(() => {
    const fetchData = async () => {
      try {
        const tagRes = await api.getTags();
        setTags(tagRes);
        if (isEdit && id) {
          const t = await api.getTalent(id);
          setForm({
            name: t.name, phone: t.phone || "", email: t.email || "",
            current_company: t.current_company || "", current_title: t.current_title || "",
            years_experience: t.years_experience?.toString() || "", city: t.city || "",
            skills: t.skills.join(", "), industry: t.industry || "",
            expected_salary: t.expected_salary || "", expected_city: t.expected_city || "",
            status: t.status, notes: t.notes || "",
          });
          setSelectedTagIds(t.tags.map((tag) => tag.id));
        }
      } catch (err) {
        alert((err as Error).message);
      }
      setLoading(false);
    };
    fetchData();
  }, [id]);

  const handleChange = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const toggleTag = (tagId: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((t) => t !== tagId) : [...prev, tagId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { alert("姓名为必填"); return; }
    setSaving(true);
    try {
      const data = {
        name: form.name.trim(), phone: form.phone || undefined, email: form.email || undefined,
        current_company: form.current_company || undefined, current_title: form.current_title || undefined,
        years_experience: form.years_experience ? parseInt(form.years_experience, 10) : undefined,
        city: form.city || undefined,
        skills: form.skills.split(",").map((s) => s.trim()).filter(Boolean),
        industry: form.industry || undefined, expected_salary: form.expected_salary || undefined,
        expected_city: form.expected_city || undefined, status: form.status,
        notes: form.notes || undefined, tag_ids: selectedTagIds,
      };
      if (isEdit && id) { await api.updateTalent(id, data); } else { await api.createTalent(data); }
      navigate("/talents");
    } catch (err) {
      alert((err as Error).message);
    }
    setSaving(false);
  };

  if (loading) return <div className="loading">加载中…</div>;

  return (
    <div className="page">
      <div className="page-header"><h1>{isEdit ? "编辑人才" : "新增人才"}</h1></div>
      <form className="talent-form" onSubmit={handleSubmit}>
        <div className="form-section">
          <h3>基本信息</h3>
          <div className="form-grid">
            <div className="form-group"><label>姓名 *</label><input type="text" value={form.name} onChange={(e) => handleChange("name", e.target.value)} required /></div>
            <div className="form-group"><label>电话</label><input type="text" value={form.phone} onChange={(e) => handleChange("phone", e.target.value)} /></div>
            <div className="form-group"><label>邮箱</label><input type="email" value={form.email} onChange={(e) => handleChange("email", e.target.value)} /></div>
            <div className="form-group"><label>当前公司</label><input type="text" value={form.current_company} onChange={(e) => handleChange("current_company", e.target.value)} /></div>
            <div className="form-group"><label>当前职位</label><input type="text" value={form.current_title} onChange={(e) => handleChange("current_title", e.target.value)} /></div>
            <div className="form-group"><label>工作年限</label><input type="number" value={form.years_experience} onChange={(e) => handleChange("years_experience", e.target.value)} /></div>
            <div className="form-group"><label>所在城市</label><input type="text" value={form.city} onChange={(e) => handleChange("city", e.target.value)} /></div>
            <div className="form-group"><label>行业</label><input type="text" value={form.industry} onChange={(e) => handleChange("industry", e.target.value)} /></div>
          </div>
        </div>
        <div className="form-section">
          <h3>求职意向</h3>
          <div className="form-grid">
            <div className="form-group"><label>期望薪资</label><input type="text" value={form.expected_salary} onChange={(e) => handleChange("expected_salary", e.target.value)} placeholder="如 30-40k" /></div>
            <div className="form-group"><label>期望城市</label><input type="text" value={form.expected_city} onChange={(e) => handleChange("expected_city", e.target.value)} /></div>
            <div className="form-group"><label>状态</label><select value={form.status} onChange={(e) => handleChange("status", e.target.value)}>{Object.entries(STATUS_LABELS).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}</select></div>
          </div>
        </div>
        <div className="form-section">
          <h3>技能 & 标签</h3>
          <div className="form-group"><label>技能 (逗号分隔)</label><input type="text" value={form.skills} onChange={(e) => handleChange("skills", e.target.value)} placeholder="如 Java, Spring, MySQL, 微服务" /></div>
          {tags.length > 0 && (
            <div className="form-group"><label>自定义标签</label><div className="tag-selector">{tags.map((tag) => (<button key={tag.id} type="button" className={`tag-option ${selectedTagIds.includes(tag.id) ? "selected" : ""}`} style={selectedTagIds.includes(tag.id) ? { background: tag.color, color: "#fff", borderColor: tag.color } : { borderColor: tag.color, color: tag.color }} onClick={() => toggleTag(tag.id)}>{tag.name}</button>))}</div></div>
          )}
        </div>
        <div className="form-section"><h3>备注</h3><div className="form-group"><textarea value={form.notes} onChange={(e) => handleChange("notes", e.target.value)} placeholder="补充说明…" rows={4} /></div></div>
        <div className="form-actions"><button type="submit" className="btn-primary" disabled={saving}>{saving ? "保存中…" : isEdit ? "保存修改" : "创建人才"}</button><button type="button" className="btn-secondary" onClick={() => navigate("/talents")}>取消</button></div>
      </form>
    </div>
  );
}
