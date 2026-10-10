import { useCallback, useEffect, useState } from "react";
import { Input, Select, Drawer, Button, Tag, Spin, message, Empty } from "antd";
import { DownloadOutlined, SendOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { Talent, TalentDetailData } from "../types";
import { ENTRY_TYPE_LABELS, ENTRY_TYPE_COLORS, ENTRY_TYPE_OPTIONS, STAGE_META } from "../types";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";

// 手机上不做页码，改成「加载更多」累加，滚动更顺
const PAGE_SIZE = 20;

export default function MTalents() {
  const [items, setItems] = useState<Talent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [entryType, setEntryType] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const profile = useIdentityProfile();

  const [detail, setDetail] = useState<TalentDetailData | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // 加入招聘流程：手机上看中了人必须能直接推进，否则人才库在这里只是个通讯录
  const [jobs, setJobs] = useState<{ id: string; title: string }[]>([]);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinJobId, setJoinJobId] = useState<string>("");
  const [joining, setJoining] = useState(false);

  const load = useCallback(
    async (p: number, append: boolean) => {
      // 空值不能塞进 params：api.getTalents 会把 undefined 转成字符串 "undefined"
      const params: Record<string, string | number> = { page: p, limit: PAGE_SIZE };
      if (q) params.q = q;
      if (entryType) params.entry_type = entryType;

      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const res = await api.getTalents(params);
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setTotal(res.total);
        setPage(p);
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [q, entryType]
  );

  useEffect(() => {
    load(1, false);
  }, [load]);

  useEffect(() => {
    api.getJobOptions().then((r) => setJobs(r.map((j) => ({ id: j.id, title: j.title })))).catch(() => {});
  }, []);

  const openDetail = async (t: Talent) => {
    setDetail(null);
    setJoinOpen(false);
    setJoinJobId("");
    setDetailOpen(true);
    try {
      setDetail(await api.getTalent(t.id));
    } catch (e) {
      message.error((e as Error).message);
      setDetailOpen(false);
    }
  };

  const joinPipeline = async () => {
    if (!detail || !joinJobId) return;
    setJoining(true);
    try {
      const r = await api.addToPipeline({ talent_id: detail.id, job_id: joinJobId });
      message.success(`已加入「${r.job_title}」的招聘流程`);
      setJoinOpen(false);
      setJoinJobId("");
      // 刷新详情，让「招聘进展」立刻多出一条
      setDetail(await api.getTalent(detail.id));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setJoining(false);
    }
  };

  const hasMore = items.length < total;

  return (
    <div>
      <div className="m-filter">
        <Input.Search
          placeholder="姓名 / 公司 / 职位 / 技能"
          allowClear
          onSearch={(v) => setQ(v.trim())}
          style={{ flex: 1 }}
        />
      </div>
      <div className="m-filter">
        <Select
          placeholder="全部录入方式"
          allowClear
          value={entryType || undefined}
          onChange={(v) => setEntryType(v || "")}
          options={ENTRY_TYPE_OPTIONS}
          style={{ flex: 1 }}
        />
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <Spin />
        </div>
      ) : items.length === 0 ? (
        <div className="m-empty">{termFor(profile, "没有找到匹配的人才")}</div>
      ) : (
        <>
          <div className="m-total-hint">共 {total} 人</div>
          {items.map((t) => (
            <div key={t.id} className="m-card" onClick={() => openDetail(t)}>
              <div className="m-card-row" style={{ justifyContent: "space-between" }}>
                <span className="m-card-title">{t.name}</span>
                {t.stage && STAGE_META[t.stage] ? (
                  <Tag color={STAGE_META[t.stage].color} style={{ flex: "none", marginInlineEnd: 0 }}>
                    {STAGE_META[t.stage].label}
                  </Tag>
                ) : null}
              </div>
              <div className="m-card-meta">
                {[t.current_company, t.current_title].filter(Boolean).join(" · ") || "暂无在职信息"}
              </div>
              <div className="m-card-meta">
                {[
                  t.years_experience != null ? `${t.years_experience} 年经验` : "",
                  t.education,
                  t.city,
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </div>
              <div className="m-tag-row">
                {t.source ? <Tag color="blue" style={{ marginInlineEnd: 0 }}>{t.source}</Tag> : null}
                {t.entry_type ? (
                  <Tag
                    color={ENTRY_TYPE_COLORS[t.entry_type]}
                    style={{ marginInlineEnd: 0 }}
                  >
                    {ENTRY_TYPE_LABELS[t.entry_type] || t.entry_type}
                  </Tag>
                ) : null}
                {t.phone ? (
                  <span className="m-card-inline">{t.phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")}</span>
                ) : null}
              </div>
            </div>
          ))}

          {hasMore ? (
            <Button block loading={loadingMore} onClick={() => load(page + 1, true)}>
              加载更多（{items.length}/{total}）
            </Button>
          ) : null}
        </>
      )}

      <Drawer
        rootClassName="m-drawer"
        placement="bottom"
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        height="auto"
        styles={{ body: { paddingBottom: 20, maxHeight: "78vh", overflowY: "auto" } }}
      >
        {!detail ? (
          <div style={{ textAlign: "center", padding: "30px 0" }}>
            <Spin />
          </div>
        ) : (
          <div>
            <div className="m-sheet-title">{detail.name}</div>
            <div className="m-sheet-sub">
              {[detail.phone, detail.email].filter(Boolean).join(" · ") || "未留联系方式"}
            </div>

            <div className="m-kv">
              {[
                ["现职位", detail.current_title],
                ["现公司", detail.current_company],
                ["经验", detail.years_experience != null ? `${detail.years_experience} 年` : null],
                ["学历", detail.education],
                ["学校", detail.school],
                ["城市", detail.city],
                ["期望薪资", detail.expected_salary],
                ["期望城市", detail.expected_city],
                ["来源渠道", detail.source],
                [
                  "录入方式",
                  detail.entry_type ? ENTRY_TYPE_LABELS[detail.entry_type] || detail.entry_type : null,
                ],
              ]
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k as string} className="m-kv-item">
                    <span className="m-kv-k">{k}</span>
                    <span className="m-kv-v">{v as string}</span>
                  </div>
                ))}
            </div>

            {detail.skills?.length ? (
              <>
                <div className="m-field-label">技能</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {detail.skills.map((s) => (
                    <Tag key={s} style={{ marginInlineEnd: 0, fontSize: 13 }}>
                      {s}
                    </Tag>
                  ))}
                </div>
              </>
            ) : null}

            {detail.notes ? (
              <>
                <div className="m-field-label">备注</div>
                <div className="m-notes">{detail.notes}</div>
              </>
            ) : null}

            {detail.pipeline?.length ? (
              <>
                <div className="m-field-label">招聘进展</div>
                {detail.pipeline.map((p) => {
                  const st = STAGE_META[p.stage];
                  return (
                    <div key={p.id} className="m-list-row">
                      <span className="m-list-main">{p.job_title}</span>
                      <Tag color={st?.color} style={{ flex: "none", marginInlineEnd: 0 }}>
                        {st?.label || p.stage}
                      </Tag>
                    </div>
                  );
                })}
              </>
            ) : null}

            <div className="m-actions">
              {joinOpen ? (
                <>
                  <div className="m-field-label">{termFor(profile, "选择岗位")}</div>
                  <Select
                    placeholder={termFor(profile, "选择要加入的岗位")}
                    value={joinJobId || undefined}
                    onChange={setJoinJobId}
                    options={jobs.map((j) => ({ value: j.id, label: j.title }))}
                    style={{ width: "100%" }}
                  />
                  <Button block type="primary" disabled={!joinJobId} loading={joining} onClick={joinPipeline}>
                    确认加入
                  </Button>
                  <Button block onClick={() => setJoinOpen(false)}>
                    取消
                  </Button>
                </>
              ) : (
                <Button
                  block
                  type="primary"
                  icon={<SendOutlined />}
                  disabled={jobs.length === 0}
                  onClick={() => setJoinOpen(true)}
                >
                  加入招聘流程
                </Button>
              )}

              {detail.resume_url ? (
                <Button
                  block
                  icon={<DownloadOutlined />}
                  onClick={async () => {
                    try { window.open(await api.getResumeDownloadUrl(detail.id), "_blank"); } catch { /* 忽略 */ }
                  }}
                >
                  下载简历
                </Button>
              ) : (
                <div style={{ textAlign: "center" }}>
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="未上传简历"
                    style={{ margin: "4px 0" }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
