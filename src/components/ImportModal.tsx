import { useState, useEffect, useRef } from "react";
import {
  Modal, Upload, Button, Alert, message, Typography, Select,
} from "antd";
import { InboxOutlined } from "@ant-design/icons";
import { api } from "../api";
import { useDict } from "../dict";
import ImportPreviewModal from "./ImportPreviewModal";
import {
  parseResumeToTalent, recordToData,
} from "../utils/resumeImport";
import type { ParsedTalent } from "../utils/resumeImport";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";

const { Dragger } = Upload;

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function ImportModal({ open, onClose, onSuccess }: Props) {
  const { sources } = useDict();
  const profile = useIdentityProfile();
  const [parsing, setParsing] = useState(false);
  const [records, setRecords] = useState<ParsedTalent[]>([]);
  const [error, setError] = useState("");
  // 本批来源渠道：整批统一选一次（用户拍定），保存每条时注入 source。
  // 不选也不阻断——漏斗页「渠道效果」会提示未记录占比过高。
  const [batchSource, setBatchSource] = useState<string | undefined>(undefined);
  const parsingRef = useRef(false);
  // 多文件选择的缓冲：beforeUpload 对每个文件同步调用一次，先用队列收齐，再统一解析
  const pendingFilesRef = useRef<File[]>([]);
  // 行 key 全局递增：此前用批次内下标，分两次上传会生成重复 key，
  // 导致按 key 编辑/删除时同时命中多行。
  const keySeq = useRef(0);
  const nextKey = () => `row-${keySeq.current++}`;

  // 逐份核对：reviewKey 指向当前正在核对的记录（null 表示未打开）
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const [savingOne, setSavingOne] = useState(false);
  // 本轮已录入份数，用于结束时汇总
  const savedCount = useRef(0);

  // 批量确认进度：一次性录入剩余全部时，核对弹窗内常驻显示「正在录入 x/y」
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);

  // 组件常驻（父级只切换 open），每次打开都从干净状态开始，
  // 避免上次没处理完的解析记录/核对弹窗残留到下一次导入。
  useEffect(() => {
    if (!open) return;
    setParsing(false);
    setRecords([]);
    setError("");
    setReviewKey(null);
    setSavingOne(false);
    savedCount.current = 0;
    pendingFilesRef.current = [];
    // 来源渠道每次打开都重置：宁可多选一次，也不能把上一批的渠道错标到新一批
    setBatchSource(undefined);
  }, [open]);

  const handleFiles = async (files: File[]) => {
    if (parsingRef.current) return;
    parsingRef.current = true;
    setError("");
    setParsing(true);
    try {
      const parsed: ParsedTalent[] = [];
      for (const file of files) {
        // 抽文本 + 本地规则兜底 + AI 解析（失败/超时自动回退），与智能匹配页共用同一套解析
        const { talent } = await parseResumeToTalent(file, nextKey());
        parsed.push(talent);
      }
      setRecords((prev) => [...prev, ...parsed]);
      // 简历模式下解析完自动进入逐份核对（从第一份开始）
      if (parsed.length > 0 && parsed[0].file) {
        setReviewKey((cur) => cur ?? parsed[0].key);
      }
      // 兜底提示：关键字段（姓名/手机号）未识别出来时提醒用户手动确认
      const missingName = parsed.filter((r) => !r.name).length;
      const missingPhone = parsed.filter((r) => !r.phone).length;
      const aiCount = parsed.filter((r) => r._ai).length;
      const localCount = parsed.length - aiCount;
      const missing: string[] = [];
      if (missingName > 0) missing.push(`${missingName} 条缺少姓名`);
      if (missingPhone > 0) missing.push(`${missingPhone} 条缺少手机号`);
      const srcNote = `AI ${aiCount} 份 / 本地规则 ${localCount} 份`;
      if (missing.length > 0) {
        message.warning(`已解析 ${parsed.length} 份简历（${srcNote}），其中 ${missing.join("、")}（已置空并标黄），请逐份核对补充后再录入`, 6);
      } else {
        message.success(`已解析 ${parsed.length} 份简历（${srcNote}），请逐份核对后录入`);
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setParsing(false);
    parsingRef.current = false;
  };

  const handleBeforeUpload = (file: File) => {
    pendingFilesRef.current.push(file);
    // beforeUpload 对同一批选择的多个文件是同步依次调用的，
    // 用 setTimeout(0) 把"统一解析"推迟到本轮同步调用全部结束后，一次性处理所有文件
    setTimeout(() => {
      if (pendingFilesRef.current.length === 0) return;
      const files = pendingFilesRef.current;
      pendingFilesRef.current = [];
      handleFiles(files);
    }, 0);
    return false;
  };

  const updateRecord = (key: string, field: keyof ParsedTalent, value: any) => {
    setRecords((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  };

  // 当前正在核对的记录
  const reviewRecord = records.find((r) => r.key === reviewKey) || null;
  const reviewIndex = reviewRecord ? records.findIndex((r) => r.key === reviewRecord.key) : 0;

  // 逐份核对：保存单条（写入人才库 + 保存原始简历）
  const saveRecord = async (rec: ParsedTalent) => {
    // 注入本批统一选择的来源渠道（未选则 undefined，落库为 null）
    const data = { ...recordToData(rec), source: batchSource || undefined };
    const res = await api.importTalents([data]);
    const created = res.items?.[0];
    if (created && rec.file) {
      try {
        await api.uploadResume(created.id, rec.file);
      } catch (e) {
        console.error(`上传简历失败: ${rec.fileName}`, e);
        message.warning("简历文件保存失败，可稍后在人才详情页重新上传");
      }
    }
  };

  // 处理完当前记录后自动切到下一份；全部处理完则刷新列表并关闭导入弹窗
  const advanceReview = (key: string) => {
    const idx = records.findIndex((r) => r.key === key);
    const remaining = records.filter((r) => r.key !== key);
    if (remaining.length === 0) {
      setRecords([]);
      setReviewKey(null);
      message.success(savedCount.current > 0
        ? termFor(profile, `已录入 ${savedCount.current} 份，人才库列表已更新`)
        : "已处理完全部简历");
      onSuccess();
      onClose();
      return;
    }
    const next = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)];
    setRecords(remaining);
    setReviewKey(next.key);
  };

  const handleSaveOne = async () => {
    const rec = reviewRecord;
    if (!rec) return;
    if (!rec.name.trim()) {
      message.error("请先填写姓名再录入");
      return;
    }
    // 手机号查重：命中已有记录时先让用户确认，避免同一个人重复入库
    if (rec.phone.trim()) {
      try {
        const dup = await api.getTalents({ phone: rec.phone.trim(), page: 1, limit: 5 });
        const hit = dup.items.find((t) => (t.phone || "") === rec.phone.trim());
        if (hit) {
          const ok = await new Promise<boolean>((resolve) => {
            Modal.confirm({
              // 层级必须高于核对弹窗（1050），否则确认框被盖住，
              // 界面看起来就是「点了保存但什么都没发生，之后点哪都没反应」
              zIndex: 1100,
              getContainer: () => document.body,
              title: "可能重复录入",
              content: termFor(profile, `手机号 ${rec.phone} 已存在人才「${hit.name}」，仍要再录一条吗？`),
              okText: "仍然录入",
              cancelText: "返回修改",
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
            });
          });
          if (!ok) return;
        }
      } catch {
        // 查重尽力而为，接口异常不阻断正常录入
      }
    }
    setSavingOne(true);
    setError("");
    try {
      await saveRecord(rec);
      savedCount.current += 1;
      // 每录一份就刷新一次人才库列表，而不是等全部处理完
      onSuccess();
      message.success(termFor(profile, `已录入「${rec.name || rec.fileName || "未命名"}」（第 ${reviewIndex + 1}/${records.length} 份），人才库列表已更新`));
      advanceReview(rec.key);
    } catch (err) {
      // 错误 Alert 在上传弹窗里，核对弹窗盖住时用户根本看不到；
      // 录入失败必须同时用 message 弹出来，否则表现就是「点了没反应」
      const msg = (err as Error).message || "录入失败";
      setError(msg);
      message.error(`录入失败：${msg}`);
    }
    setSavingOne(false);
  };

  const handleSkipOne = () => {
    const rec = reviewRecord;
    if (!rec) return;
    message.info(`已移除「${rec.name || rec.fileName || "未命名"}」`);
    advanceReview(rec.key);
  };

  // 全部确认：把当前队列里剩下的记录一次性录入，不再逐份点「保存并录入」。
  // 解析结果可信时（批量同渠道导入）用这个最省事；注意跳过逐条手机号查重，
  // 否则每份都弹一次确认框，批量就失去意义了。
  const handleConfirmAll = async () => {
    const list = records.filter((r) => r.name.trim());
    const skipNoName = records.length - list.length;
    if (list.length === 0) {
      message.error("没有可录入的记录：解析结果缺少姓名，请先补填");
      return;
    }
    setSavingOne(true);
    setError("");
    let ok = 0;
    const failed: string[] = [];
    setBatchProgress({ current: 0, total: list.length });
    for (let i = 0; i < list.length; i++) {
      setBatchProgress({ current: i + 1, total: list.length });
      try {
        await saveRecord(list[i]);
        savedCount.current += 1;
        ok += 1;
      } catch (err) {
        failed.push(list[i].name || list[i].fileName || "未命名");
      }
    }
    setBatchProgress(null);
    setSavingOne(false);
    onSuccess();
    if (failed.length === 0) {
      message.success(`已批量录入 ${ok} 份${skipNoName > 0 ? `，${skipNoName} 份因缺少姓名已跳过` : ""}`);
    } else {
      message.warning(`已录入 ${ok} 份，${failed.length} 份失败：${failed.slice(0, 3).join("、")}${failed.length > 3 ? " 等" : ""}`);
    }
    setRecords([]);
    setReviewKey(null);
    onClose();
  };

  // 关闭核对弹窗 = 放弃本轮尚未处理的简历（没有中间列表可回退，所以必须问清楚）。
  // 已录入的已经写库，不受影响。
  const handleCloseReview = () => {
    const rest = records.length;
    if (rest === 0) {
      setReviewKey(null);
      return;
    }
    Modal.confirm({
      zIndex: 1100,
      getContainer: () => document.body,
      title: "放弃剩余简历？",
      content: termFor(profile, `还有 ${rest} 份未处理，关闭后不会写入人才库（已录入的不受影响）。`),
      okText: "放弃并关闭",
      cancelText: "继续核对",
      okButtonProps: { danger: true },
      onOk: () => {
        setRecords([]);
        setReviewKey(null);
        onClose();
      },
    });
  };

  return (
    <Modal title="导入简历" open={open} onCancel={onClose} width={720} destroyOnClose footer={null}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        上传 PDF 或 Word（.docx）简历，解析完成后会<b>自动弹出核对窗口</b>：
        左边看简历原文，右边改字段，点「保存并录入」即写入{termFor(profile, "人才库")}并更新列表。
        可一次上传多份，会依次核对。
      </Typography.Paragraph>

      {/* 本批来源渠道：整批统一选一次，招聘漏斗的「渠道效果」靠它统计 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Typography.Text type="secondary" style={{ flexShrink: 0 }}>
          本批来源渠道：
        </Typography.Text>
        <Select
          allowClear
          showSearch
          style={{ minWidth: 260 }}
          placeholder="选择后应用到本批全部录入"
          value={batchSource}
          onChange={setBatchSource}
          options={sources.map((s) => ({ label: s, value: s }))}
        />
      </div>

      <Dragger accept=".pdf,.docx" multiple showUploadList={false} disabled={parsing} beforeUpload={handleBeforeUpload}>
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">点击或拖拽简历文件到此处</p>
        <p className="ant-upload-hint">支持 .pdf、.docx 格式，可一次上传多份</p>
      </Dragger>

      {parsing && <Alert message="AI 识别中…" type="info" showIcon style={{ marginTop: 16 }} />}
      {error && <Alert message={error} type="error" showIcon style={{ marginTop: 16, marginBottom: 16 }} />}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <Button onClick={onClose}>关闭</Button>
      </div>

      {/* 逐份核对弹窗：左侧简历原文，右侧可改字段，保存才录入 */}
      <ImportPreviewModal
        record={reviewRecord}
        index={reviewIndex}
        total={records.length}
        saving={savingOne}
        batchProgress={batchProgress}
        onChange={(field, value) => { if (reviewRecord) updateRecord(reviewRecord.key, field, value); }}
        onSave={handleSaveOne}
        onConfirmAll={handleConfirmAll}
        onSkip={handleSkipOne}
        onClose={handleCloseReview}
      />
    </Modal>
  );
}
