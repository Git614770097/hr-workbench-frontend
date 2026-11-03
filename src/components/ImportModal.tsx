import { useState, useEffect, useRef } from "react";
import {
  Modal, Upload, Button, Alert, message, Typography, Select, Switch, Tag,
} from "antd";
import { InboxOutlined } from "@ant-design/icons";
import { api } from "../api";
import { useDict } from "../dict";
import ImportPreviewModal from "./ImportPreviewModal";
import {
  parseResumeToTalent, recordToData, blankRecordForFile,
} from "../utils/resumeImport";
import type { ParsedTalent } from "../utils/resumeImport";

const { Dragger } = Upload;

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function ImportModal({ open, onClose, onSuccess }: Props) {
  const { sources } = useDict();
  const [parsing, setParsing] = useState(false);
  const [records, setRecords] = useState<ParsedTalent[]>([]);
  const [error, setError] = useState("");
  // 本批来源渠道：整批统一选一次（用户拍定），保存每条时注入 source。
  // 不选也不阻断——漏斗页「渠道效果」会提示未记录占比过高。
  const [batchSource, setBatchSource] = useState<string | undefined>(undefined);
  // 自动去重开关：默认开。开启后录入时按「手机号 / 姓名+现居城市」判重，命中的跳过不重复入库
  const [dedup, setDedup] = useState(true);
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

  // ---- 导入记录（上传 N 份 / 录入 N 份 / 失败 N 份，事后可查）----
  // 批次在第一次选中文件时才创建，不是打开弹窗时——否则用户点开又关掉会留一堆 0 份的空批次。
  const batchIdRef = useRef<string | null>(null);
  // 前端行 key → 明细 id。文件名可能重复，只能靠解析时分配的 key 映射。
  const itemIdByKey = useRef<Record<string, string>>({});
  // 失败文件的明细 id（按 files 下标）：用户改用「手动录入」后要回写状态
  const failedItemIdByIndex = useRef<Record<number, string>>({});

  // 失败分组：按原因归并，避免把几十份同样的文案拼成一堵墙
  const [failGroups, setFailGroups] = useState<{ message: string; names: string[] }[]>([]);
  // 可以转成手工录入的失败文件（带原始 File，造空白记录时要靠它）
  const [manualCandidates, setManualCandidates] = useState<{ index: number; file: File; message: string }[]>([]);

  /**
   * 记录失败绝不能连累导入本身。
   * 导入记录是「事后追溯」的辅助能力，它挂了也要让用户把简历录进去——
   * 所以这里所有调用都是 catch 吞掉的 fire-and-forget，没有一个 await 在关键路径上。
   */
  const ensureBatch = async (): Promise<string | null> => {
    if (batchIdRef.current) return batchIdRef.current;
    try {
      const { id } = await api.createImportBatch({ source: batchSource || null, dedup });
      batchIdRef.current = id;
      return id;
    } catch {
      return null;
    }
  };

  /** 更新单份明细状态：录入成功 / 判重跳过 / 录入报错 各调一次 */
  const markItem = (key: string, patch: { status?: string; talent_id?: string | null; talent_name?: string; error?: string }) => {
    const bid = batchIdRef.current;
    const iid = itemIdByKey.current[key];
    if (!bid || !iid) return;
    api.updateImportBatchItem(bid, iid, patch).catch(() => {});
  };

  /** 结束批次：全部处理完 / 用户关闭弹窗时调用，幂等 */
  const finishBatch = () => {
    const bid = batchIdRef.current;
    if (!bid) return;
    batchIdRef.current = null;
    api.finishImportBatch(bid).catch(() => {});
  };

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
    // 上一批的批次号不能带过来，否则新一批的明细会记到旧批次里
    batchIdRef.current = null;
    itemIdByKey.current = {};
    failedItemIdByIndex.current = {};
    setFailGroups([]);
    setManualCandidates([]);
    // 来源渠道每次打开都重置：宁可多选一次，也不能把上一批的渠道错标到新一批
    setBatchSource(undefined);
    // 自动去重默认开：避免用户误点「全部确认」把已入库的人重复写入
    setDedup(true);
  }, [open]);

  const handleFiles = async (files: File[]) => {
    if (parsingRef.current) return;
    parsingRef.current = true;
    setError("");
    setParsing(true);
    try {
      const parsed: ParsedTalent[] = [];
      // 逐份容错：扫描件 / 损坏文件只跳过它自己，不能连累同批其余简历
      const failed: { index: number; file: File; message: string }[] = [];
      // 与 files 严格同序：下标 i 就是 files[i] 的命运，最后一次性提交成导入明细。
      // 解析失败的也要占一行——「上传 20 份只进来 13 份」里的差额必须在记录里看得见，
      // 只记成功的话，这份记录就只会在有失败时有用，而顺利时根本没人来查。
      const logItems: {
        file_name: string; file_size: number; talent_name?: string;
        status: string; error?: string; parse_source?: string;
      }[] = [];
      const keyByIndex: (string | null)[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const key = nextKey();
        try {
          // 上传到服务端抽文本 + AI 解析（AI 不可用时服务端已降级为本地规则；
          // 图片型 PDF 服务端会先做视觉识别，识别出的文本照常走后面的管线）
          const { talent } = await parseResumeToTalent(file, key);
          parsed.push(talent);
          keyByIndex.push(key);
          logItems.push({
            file_name: file.name,
            file_size: file.size,
            talent_name: talent.name || undefined,
            status: "pending",
            parse_source: talent._ai ? "ai" : "local",
          });
        } catch (e) {
          keyByIndex.push(null);
          logItems.push({
            file_name: file.name,
            file_size: file.size,
            status: "failed",
            error: (e as Error).message,
          });
          failed.push({ index: i, file, message: (e as Error).message });
        }
      }

      // 落导入记录：一次 POST 提交本批全部文件。返回的 ids 与提交顺序一一对应
      // （文件名可能重复，只有下标能可靠映射回前端记录）。
      // 整段吞异常：导入记录是事后追溯用的辅助能力，不能因为它挂了让人录不进简历。
      try {
        const bid = await ensureBatch();
        if (bid) {
          const { ids } = await api.addImportBatchItems(bid, logItems);
          ids.forEach((id, i) => {
            const k = keyByIndex[i];
            if (k) itemIdByKey.current[k] = id;
            // 失败的那几份也要记住明细 id：用户点「手动录入」后它们会转成
            // pending 甚至 imported，没有 id 就回写不了，记录会永远停在 failed
            else failedItemIdByIndex.current[i] = id;
          });
        }
      } catch {
        /* 忽略：不影响导入 */
      }
      if (failed.length > 0) {
        // 按原因分组，而不是把每份的完整文案拼成一串。
        // 27 份扫描件会拼出上千字，真正要看的信息（共几份、为什么）全被淹了。
        const groups = new Map<string, string[]>();
        for (const f of failed) {
          const list = groups.get(f.message) || [];
          list.push(f.file.name);
          groups.set(f.message, list);
        }
        setFailGroups([...groups.entries()].map(([message, names]) => ({ message, names })));
        setManualCandidates(failed);
        if (parsed.length === 0) {
          setParsing(false);
          parsingRef.current = false;
          return;
        }
      }
      setRecords((prev) => [...prev, ...parsed]);
      // 简历模式下解析完自动进入逐份核对（从第一份开始）
      if (parsed.length > 0 && parsed[0].file) {
        setReviewKey((cur) => cur ?? parsed[0].key);
      }
      // 兜底提示：关键字段（姓名/手机号）未识别出来时提醒用户手动确认
      const missingNameRecs = parsed.filter((r) => !r.name);
      const missingName = missingNameRecs.length;
      const missingNameFiles = missingNameRecs.map((r) => r.fileName);
      const missingPhone = parsed.filter((r) => !r.phone).length;
      const aiCount = parsed.filter((r) => r._ai).length;
      const localCount = parsed.length - aiCount;
      const ocrCount = parsed.filter((r) => r._ocr).length;
      const missing: string[] = [];
      if (missingName > 0) missing.push(`${missingName} 份缺少姓名（${missingNameFiles.join("、")}）`);
      if (missingPhone > 0) missing.push(`${missingPhone} 份缺少手机号`);
      // 图片识别出来的要单独点名：识别错字（尤其数字和生僻字）比文本 PDF 多得多
      const ocrNote = ocrCount > 0 ? `，其中 ${ocrCount} 份是图片识别，请重点核对数字` : "";
      const srcNote = `AI ${aiCount} 份 / 本地规则 ${localCount} 份`;
      if (missing.length > 0) {
        message.warning(`已解析 ${parsed.length} 份简历（${srcNote}${ocrNote}），其中 ${missing.join("、")}（已置空并标黄），请逐份核对补充后再录入`, 6);
      } else {
        message.success(`已解析 ${parsed.length} 份简历（${srcNote}${ocrNote}），请逐份核对后录入`);
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

  /**
   * 把解析失败的文件转成空白记录，让用户照着原文件手工填。
   *
   * 原来的做法是「全失败就只弹一条错误，一条记录都不生成」——而错误文案里
   * 写着「或手动填写信息」。用户既导不进来也填不了，只能反复重传同一份文件。
   * 现在给一个明确出口：点一下就把这些文件变成可编辑的空记录，
   * 核对弹窗左侧照样能打开原 PDF（图片型 PDF 也能看见扫描内容）。
   */
  const handleManualEntry = () => {
    if (manualCandidates.length === 0) return;
    const blanks = manualCandidates.map((f) => {
      const key = nextKey();
      // 复用原来那条明细的 id，用户填完保存后状态能从 failed 改成 imported
      const itemId = failedItemIdByIndex.current[f.index];
      if (itemId) itemIdByKey.current[key] = itemId;
      return blankRecordForFile(f.file, key, f.message);
    });
    setRecords((prev) => [...prev, ...blanks]);
    setReviewKey((cur) => cur ?? blanks[0].key);
    setFailGroups([]);
    setManualCandidates([]);
    message.info(`已转为手工录入 ${blanks.length} 份，左侧可以对照原文件填写`);
  };

  // 当前正在核对的记录
  const reviewRecord = records.find((r) => r.key === reviewKey) || null;
  const reviewIndex = reviewRecord ? records.findIndex((r) => r.key === reviewRecord.key) : 0;

  // 逐份核对：保存单条（写入人才库 + 保存原始简历）
  const saveRecord = async (rec: ParsedTalent) => {
    // 注入本批统一选择的来源渠道（未选则 undefined，落库为 null）
    const data = { ...recordToData(rec), source: batchSource || undefined };
    // dedup=true 时后端判重，命中则跳过不插入（created 为空、skipped 有值）
    const res = await api.importTalents([data], { dedup });
    const created = res.items?.[0];
    const skipped = res.skipped?.[0];
    // 结果先落盘再传简历文件：文件上传失败时人已经在库里了，
    // 记录该是「已录入」而不是「失败」——否则用户会以为白录了一遍。
    if (created) {
      markItem(rec.key, { status: "imported", talent_id: created.id, talent_name: rec.name });
    } else if (skipped) {
      markItem(rec.key, { status: "duplicate", talent_name: rec.name });
    }
    if (created && rec.file) {
      try {
        await api.uploadResume(created.id, rec.file);
      } catch (e) {
        console.error(`上传简历失败: ${rec.fileName}`, e);
        message.warning("简历文件保存失败，可稍后在人才详情页重新上传");
      }
    }
    return { created, skipped };
  };

  // 处理完当前记录后自动切到下一份；全部处理完则刷新列表并关闭导入弹窗
  const advanceReview = (key: string) => {
    const idx = records.findIndex((r) => r.key === key);
    const remaining = records.filter((r) => r.key !== key);
    if (remaining.length === 0) {
      setRecords([]);
      setReviewKey(null);
      // 全部处理完 = 批次自然结束。没处理完就关弹窗的走 finishBatch 的另一处调用。
      finishBatch();
      message.success(savedCount.current > 0
        ? `已录入 ${savedCount.current} 份，人才库列表已更新`
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
    // 开启「自动去重」时交给后端判重并直接跳过，这里不再弹确认框
    if (!dedup && rec.phone.trim()) {
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
              content: `手机号 ${rec.phone} 已存在人才「${hit.name}」，仍要再录一条吗？`,
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
      const { created, skipped } = await saveRecord(rec);
      if (!created && skipped) {
        // 后端判重后跳过，未写入人才库
        message.info(`「${rec.name || rec.fileName || "未命名"}」已存在，已跳过`);
      } else {
        savedCount.current += 1;
        // 每录一份就刷新一次人才库列表，而不是等全部处理完
        onSuccess();
        message.success(`已录入「${rec.name || rec.fileName || "未命名"}」（第 ${reviewIndex + 1}/${records.length} 份），人才库列表已更新`);
      }
      advanceReview(rec.key);
    } catch (err) {
      // 错误 Alert 在上传弹窗里，核对弹窗盖住时用户根本看不到；
      // 录入失败必须同时用 message 弹出来，否则表现就是「点了没反应」
      const msg = (err as Error).message || "录入失败";
      setError(msg);
      markItem(rec.key, { status: "failed", error: msg, talent_name: rec.name });
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
  // 解析结果可信时（批量同渠道导入）用这个最省事。
  // 去重交给后端：开关打开时后端按「手机号 / 姓名+现居城市」判重并跳过，
  // 这样即使误点这里，也不会把已入库的人重复写入。
  const handleConfirmAll = async () => {
    const list = records.filter((r) => r.name.trim());
    const noName = records.filter((r) => !r.name.trim());
    const skipNoName = noName.length;
    const skipFiles = noName.map((r) => r.fileName);
    if (list.length === 0) {
      message.error("没有可录入的记录：解析结果缺少姓名，请先补填");
      return;
    }
    setSavingOne(true);
    setError("");
    let ok = 0;
    const failed: string[] = [];
    const dupNames: string[] = [];
    setBatchProgress({ current: 0, total: list.length });
    for (let i = 0; i < list.length; i++) {
      setBatchProgress({ current: i + 1, total: list.length });
      try {
        const { created, skipped } = await saveRecord(list[i]);
        if (!created && skipped) {
          dupNames.push(list[i].name || list[i].fileName || "未命名");
        } else {
          savedCount.current += 1;
          ok += 1;
        }
      } catch (err) {
        failed.push(list[i].name || list[i].fileName || "未命名");
        markItem(list[i].key, {
          status: "failed",
          error: (err as Error).message || "录入失败",
          talent_name: list[i].name,
        });
      }
    }
    setBatchProgress(null);
    setSavingOne(false);
    onSuccess();
    const notes = [`已录入 ${ok} 份`];
    if (dupNames.length > 0) notes.push(`已跳过重复 ${dupNames.length} 份`);
    if (skipNoName > 0) notes.push(`${skipNoName} 份因缺少姓名已跳过（${skipFiles.join("、")}）`);
    const summary = notes.join("，");
    if (failed.length > 0) {
      message.warning(`${summary}，${failed.length} 份失败：${failed.slice(0, 3).join("、")}${failed.length > 3 ? " 等" : ""}`);
    } else {
      message.success(summary);
    }
    setRecords([]);
    setReviewKey(null);
    finishBatch();
    onClose();
  };

  // 关闭核对弹窗 = 放弃本轮尚未处理的简历（没有中间列表可回退，所以必须问清楚）。
  // 已录入的已经写库，不受影响。
  const handleCloseReview = () => {
    const rest = records.length;
    if (rest === 0) {
      // 队列已空还点关闭：不弹确认，但批次仍要收尾，否则它会永远停在「未结束」
      setReviewKey(null);
      finishBatch();
      return;
    }
    Modal.confirm({
      zIndex: 1100,
      getContainer: () => document.body,
      title: "放弃剩余简历？",
      content: `还有 ${rest} 份未处理，关闭后不会写入人才库（已录入的不受影响）。`,
      okText: "放弃并关闭",
      cancelText: "继续核对",
      okButtonProps: { danger: true },
      onOk: () => {
        setRecords([]);
        setReviewKey(null);
        // 放弃的份数在导入记录里留在 pending 态——「上传 20 份录了 13 份」
        // 这个差额正是用户事后想查的东西，不要抹成「失败」。
        finishBatch();
        onClose();
      },
    });
  };

  // 直接点导入弹窗的关闭：同样结束批次，避免批次永远停在「未结束」
  const handleCloseModal = () => {
    finishBatch();
    onClose();
  };

  return (
    <Modal title="导入简历" open={open} onCancel={handleCloseModal} width={720} destroyOnClose footer={null}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        上传 PDF 或 Word（.docx）简历，解析完成后会<b>自动弹出核对窗口</b>：
        左边看简历原文，右边改字段，点「保存并录入」即写入{"人才库"}并更新列表。
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

      {/* 自动去重：默认开。开启后录入时按「手机号 / 姓名+现居城市」判重，命中的跳过，避免重复入库 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Switch checked={dedup} onChange={setDedup} size="small" />
        <Typography.Text type="secondary">
          自动跳过已存在的人才（按手机号 / 姓名+现居城市判重）
        </Typography.Text>
      </div>

      <Dragger accept=".pdf,.docx" multiple showUploadList={false} disabled={parsing} beforeUpload={handleBeforeUpload}>
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">点击或拖拽简历文件到此处</p>
        <p className="ant-upload-hint">支持 .pdf、.docx 格式，可一次上传多份</p>
      </Dragger>

      {parsing && <Alert message="AI 识别中…" type="info" showIcon style={{ marginTop: 16 }} />}
      {error && <Alert message={error} type="error" showIcon style={{ marginTop: 16, marginBottom: 16 }} />}

      {/* 解析失败：按原因归并。原来是把每份的完整文案拼成一串，
          27 份扫描件能拼出上千字，用户根本读不完，也不知道该怎么办 */}
      {failGroups.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 16 }}
          message={
            <span>
              {failGroups.reduce((n, g) => n + g.names.length, 0)} 份没能自动解析
            </span>
          }
          description={
            <div style={{ fontSize: 13 }}>
              {failGroups.map((g, gi) => (
                <div key={gi} style={{ marginBottom: gi === failGroups.length - 1 ? 0 : 10 }}>
                  <div style={{ marginBottom: 4 }}>
                    <Tag color="orange">{g.names.length} 份</Tag>
                    {g.message}
                  </div>
                  {/* 文件名最多列 8 个，再多就折叠——用户要的是「哪些」，不是逐条读完 */}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {g.names.slice(0, 8).join("、")}
                    {g.names.length > 8 ? ` 等 ${g.names.length} 份` : ""}
                  </Typography.Text>
                </div>
              ))}
              {manualCandidates.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <Button size="small" onClick={handleManualEntry}>
                    仍然手动录入这 {manualCandidates.length} 份
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                    左侧可以打开原文件对照着填
                  </Typography.Text>
                </div>
              )}
            </div>
          }
        />
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <Button onClick={handleCloseModal}>关闭</Button>
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
