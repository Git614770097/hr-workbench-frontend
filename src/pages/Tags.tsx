import { useState, useEffect } from "react";
import { api } from "../api";
import type { Tag } from "../types";

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

export default function Tags() {
  const [tags, setTags] = useState<(Tag & { talent_count?: number })[]>([]);
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(COLORS[0]);

  const fetchTags = async () => {
    try { const res = await api.getTags(); setTags(res); } catch (err) { console.error(err); }
  };
  useEffect(() => { fetchTags(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault(); if (!name.trim()) return;
    try { await api.createTag({ name: name.trim(), color }); setName(""); setColor(COLORS[0]); fetchTags(); }
    catch (err) { alert((err as Error).message); }
  };

  const handleDelete = async (id: string, tagName: string) => {
    if (!confirm(`确认删除标签「${tagName}」？`)) return;
    try { await api.deleteTag(id); fetchTags(); } catch (err) { alert((err as Error).message); }
  };

  const startEdit = (tag: Tag & { talent_count?: number }) => {
    setEditingId(tag.id); setEditName(tag.name); setEditColor(tag.color);
  };

  const handleSaveEdit = async (id: string) => {
    try { await api.updateTag(id, { name: editName, color: editColor }); setEditingId(null); fetchTags(); }
    catch (err) { alert((err as Error).message); }
  };

  return (
    <div className="page">
      <div className="page-header"><h1>标签管理</h1></div>
      <form className="tag-create-form" onSubmit={handleCreate}>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="标签名称" className="tag-name-input" />
        <div className="color-picker">{COLORS.map((c) => (<button key={c} type="button" className={`color-dot ${color === c ? "selected" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />))}</div>
        <button type="submit" className="btn-primary">+ 添加标签</button>
      </form>
      <div className="tag-list">
        {tags.length === 0 ? (<p className="empty-text">暂无标签，创建第一个吧</p>) : (
          tags.map((tag) => (
            <div key={tag.id} className="tag-row">
              {editingId === tag.id ? (<>
                <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className="tag-edit-input" />
                <div className="color-picker sm">{COLORS.map((c) => (<button key={c} type="button" className={`color-dot ${editColor === c ? "selected" : ""}`} style={{ background: c }} onClick={() => setEditColor(c)} />))}</div>
                <button className="btn-sm-primary" onClick={() => handleSaveEdit(tag.id)}>保存</button>
                <button className="btn-sm-secondary" onClick={() => setEditingId(null)}>取消</button>
              </>) : (<>
                <span className="tag-chip lg" style={{ background: tag.color + "20", color: tag.color, borderColor: tag.color }}>{tag.name}</span>
                <span className="tag-count">{tag.talent_count || 0} 人</span>
                <button className="btn-link" onClick={() => startEdit(tag)}>编辑</button>
                <button className="btn-link danger" onClick={() => handleDelete(tag.id, tag.name)}>删除</button>
              </>)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
