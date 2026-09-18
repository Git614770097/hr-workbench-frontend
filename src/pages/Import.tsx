import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

const TEMPLATE = `[
  {
    "name": "张三",
    "phone": "13800138000",
    "email": "zhangsan@example.com",
    "current_company": "阿里巴巴",
    "current_title": "高级Java工程师",
    "years_experience": 6,
    "city": "杭州",
    "skills": ["Java", "Spring", "MySQL", "微服务"],
    "industry": "互联网",
    "expected_salary": "35-45k",
    "expected_city": "杭州",
    "status": "active"
  },
  {
    "name": "李四",
    "phone": "13900139000",
    "current_company": "腾讯",
    "current_title": "前端架构师",
    "years_experience": 8,
    "city": "深圳",
    "skills": ["React", "Vue", "TypeScript", "Node.js"],
    "industry": "互联网",
    "status": "passive"
  }
]`;

export default function Import() {
  const navigate = useNavigate();
  const [jsonText, setJsonText] = useState(TEMPLATE);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number } | null>(null);
  const [error, setError] = useState("");

  const handleImport = async () => {
    setError(""); setResult(null); setImporting(true);
    try {
      const data = JSON.parse(jsonText);
      if (!Array.isArray(data)) throw new Error("数据必须是 JSON 数组格式");
      const res = await api.importTalents(data);
      setResult(res);
    } catch (err) {
      setError((err as Error).message);
    }
    setImporting(false);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setJsonText(ev.target?.result as string); };
    reader.readAsText(file);
  };

  return (
    <div className="page">
      <div className="page-header"><h1>批量导入人才</h1></div>
      <div className="import-info">
        <p>支持 JSON 数组格式导入。每条记录可包含以下字段：</p>
        <ul>
          <li><code>name</code> (必填) - 姓名</li>
          <li><code>phone</code> - 电话</li>
          <li><code>email</code> - 邮箱</li>
          <li><code>current_company</code> - 当前公司</li>
          <li><code>current_title</code> - 当前职位</li>
          <li><code>years_experience</code> - 工作年限</li>
          <li><code>city</code> - 城市</li>
          <li><code>skills</code> - 技能数组，如 ["Java", "Spring"]</li>
          <li><code>industry</code> - 行业</li>
          <li><code>expected_salary</code> - 期望薪资</li>
          <li><code>expected_city</code> - 期望城市</li>
          <li><code>status</code> - 状态：active / passive / placed / do_not_contact</li>
        </ul>
      </div>
      <div className="import-actions">
        <label className="btn-secondary file-upload-label">📁 上传 JSON 文件<input type="file" accept=".json" onChange={handleFileUpload} hidden /></label>
      </div>
      <textarea className="json-editor" value={jsonText} onChange={(e) => setJsonText(e.target.value)} rows={20} spellCheck={false} />
      <div className="import-bottom">
        <button className="btn-primary" onClick={handleImport} disabled={importing}>{importing ? "导入中…" : "开始导入"}</button>
        {error && <div className="form-error">{error}</div>}
        {result && (<div className="import-success">✅ 成功导入 {result.imported} 条人才记录<button className="btn-link" onClick={() => navigate("/talents")}>查看人才库 →</button></div>)}
      </div>
    </div>
  );
}
