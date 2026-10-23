import { MATRIX_ROWS, type MatrixCol, type MatrixTone } from "./matchMatrix";

/**
 * 把对比矩阵画成一张 PNG 长图（给 HR 转发给用人部门用）。
 *
 * 为什么不用 html2canvas / html-to-image：
 * 1. 体积——html2canvas 约 50KB gzip，你这网络下载只有 8~15KB/s，等于多等 10 秒；
 * 2. 稳定性——两者都要克隆 DOM + 计算样式，遇到 CSS 变量、字体回退容易错位；
 * 3. 我们只需要「文字 + 色块」，canvas 直接画最可控，且 measureText 能精确断行。
 * 代价是导出图与屏幕样式要各维护一份——所以行定义放在 utils/matchMatrix.ts 共用，
 * 这里只负责「怎么画」，不负责「画什么」。
 */

const SCALE = 2;
const PAD = 40;
const LABEL_W = 88;
const COL_W = 210;
const PAD_X = 12;
const PAD_Y = 9;
const LINE_H = 17;
const HEAD_H = 88;
const FONT = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';

const TONE_BG: Record<MatrixTone, string> = {
  ok: "#EAF3DE",
  warn: "#FAEEDA",
  bad: "#FCEBEB",
  neutral: "#FFFFFF",
};
const TONE_FG: Record<MatrixTone, string> = {
  ok: "#27500A",
  warn: "#633806",
  bad: "#791F1F",
  neutral: "#1F2329",
};

const C_TEXT = "#1F2329";
const C_MUTED = "#6B7280";
const C_FAINT = "#9CA3AF";
const C_LINE = "#E5E7EB";
const C_LABEL_BG = "#F7F8FA";

/** 长文本行允许断 3 行，其余 2 行——行高按最长的那个算，保证同一行各列底边对齐 */
const MAX_LINES: Record<string, number> = {
  must: 3,
  nice: 2,
  reasons: 3,
  gaps: 3,
  questions: 3,
};

function font(weight: number, size: number) {
  return `${weight} ${size}px ${FONT}`;
}

/**
 * 按像素宽度断行（中文逐字断，英文尽量在空格处断）。
 * 返回 { lines, truncated }——truncated 表示还有内容没画下，末行补省略号。
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  const chars = Array.from(text || "");
  let cur = "";
  let i = 0;
  for (; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\n") {
      lines.push(cur);
      cur = "";
      if (lines.length === maxLines) break;
      continue;
    }
    if (ctx.measureText(cur + ch).width > maxWidth && cur !== "") {
      lines.push(cur);
      cur = ch;
      if (lines.length === maxLines) break;
    } else {
      cur += ch;
    }
  }
  if (lines.length < maxLines && cur) {
    lines.push(cur);
    cur = "";
  }
  // 到这一步 i 还没走完 或 还有残留，说明被截断了
  const truncated = i < chars.length - 1 || cur !== "";
  if (truncated && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && ctx.measureText(last + "…").width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = last + "…";
  }
  return { lines, truncated };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** 画完返回 blob；调用方负责下载 */
export async function renderMatrixPng(
  cols: MatrixCol[],
  title: string
): Promise<Blob> {
  if (cols.length === 0) throw new Error("没有可导出的候选人");
  const n = cols.length;
  const gridW = LABEL_W + COL_W * n;
  const totalW = gridW + PAD * 2;

  // 先用一块临时画布量文字，算出每行该多高
  const probe = document.createElement("canvas").getContext("2d")!;
  const cellW = COL_W - PAD_X * 2;

  const rowLayout = MATRIX_ROWS.map((row) => {
    const maxLines = MAX_LINES[row.key] ?? 2;
    const cells = cols.map((c) => {
      const cell = row.cell(c);
      const big = !!cell.big;
      probe.font = font(big ? 500 : 400, big ? 21 : 13);
      const main = wrapText(probe, cell.main, cellW, big ? 1 : maxLines);
      let subLines: string[] = [];
      if (cell.sub) {
        probe.font = font(400, 11);
        subLines = wrapText(probe, cell.sub, cellW, 2).lines;
      }
      return { cell, big, main: main.lines, sub: subLines };
    });
    const lines = Math.max(
      ...cells.map((c) => c.main.length + (c.sub.length > 0 ? c.sub.length : 0))
    );
    const mainH = Math.max(...cells.map((c) => c.main.length)) * (cells.some((c) => c.big) ? 26 : LINE_H);
    const subH = Math.max(...cells.map((c) => c.sub.length)) * 15;
    const h = Math.max(40, mainH + subH + PAD_Y * 2);
    return { row, cells, height: h };
  });

  const bodyH = rowLayout.reduce((s, r) => s + r.height, 0);
  const headBlock = 108;
  const footBlock = 46;
  const totalH = headBlock + HEAD_H + bodyH + footBlock + PAD;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(totalW * SCALE);
  canvas.height = Math.round(totalH * SCALE);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = "top";

  // 背景 + 外框
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, totalW, totalH);
  ctx.strokeStyle = C_LINE;
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, totalW - 1, totalH - 1, 12);
  ctx.stroke();

  // 标题
  ctx.fillStyle = C_TEXT;
  ctx.font = font(500, 19);
  ctx.fillText(`人才对比 · ${title}`, PAD, 34);
  ctx.font = font(400, 12);
  ctx.fillStyle = C_MUTED;
  ctx.fillText(`已评估 ${n} 位 · 按匹配度从高到低 · 维度名可排序`, PAD, 62);

  // 图例
  const legend: [MatrixTone, string][] = [["ok", "达标"], ["warn", "部分 / 偏高"], ["bad", "未达标"]];
  let lx = PAD;
  ctx.font = font(400, 11);
  for (const [tone, label] of legend) {
    ctx.beginPath();
    ctx.arc(lx + 4, 88, 4, 0, Math.PI * 2);
    ctx.fillStyle = tone === "ok" ? "#639922" : tone === "warn" ? "#EF9F27" : "#E24B4A";
    ctx.fill();
    ctx.fillStyle = C_FAINT;
    ctx.fillText(label, lx + 13, 81);
    lx += ctx.measureText(label).width + 30;
  }

  const gx = PAD;
  let gy = headBlock;
  const gridH = HEAD_H + bodyH;

  // 表头
  ctx.fillStyle = C_LABEL_BG;
  ctx.fillRect(gx, gy, LABEL_W, HEAD_H);
  cols.forEach((c, i) => {
    const x = gx + LABEL_W + i * COL_W;
    ctx.fillStyle = C_LABEL_BG;
    ctx.fillRect(x, gy, COL_W, HEAD_H);

    // 排名圆点
    ctx.fillStyle = i === 0 ? "#FBBF24" : "#E6F1FB";
    ctx.beginPath();
    ctx.arc(x + PAD_X + 10, gy + 22, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = i === 0 ? "#FFFFFF" : "#185FA5";
    ctx.font = font(500, 11);
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1), x + PAD_X + 10, gy + 16);
    ctx.textAlign = "left";

    ctx.fillStyle = C_TEXT;
    ctx.font = font(500, 14);
    const nameLines = wrapText(ctx, c.name, COL_W - PAD_X * 2 - 28, 1).lines;
    ctx.fillText(nameLines[0] || "", x + PAD_X + 26, gy + 15);

    ctx.fillStyle = C_FAINT;
    ctx.font = font(400, 11);
    const subLines = wrapText(ctx, c.sub || "—", COL_W - PAD_X * 2, 2).lines;
    subLines.forEach((ln, k) => ctx.fillText(ln, x + PAD_X, gy + 40 + k * 15));
  });

  // 分隔线（表头下）
  ctx.strokeStyle = C_LINE;
  ctx.beginPath();
  ctx.moveTo(gx, gy + HEAD_H);
  ctx.lineTo(gx + gridW, gy + HEAD_H);
  ctx.stroke();

  // 行
  gy += HEAD_H;
  rowLayout.forEach(({ row, cells, height }) => {
    // 标签列
    ctx.fillStyle = C_LABEL_BG;
    ctx.fillRect(gx, gy, LABEL_W, height);
    ctx.fillStyle = C_MUTED;
    ctx.font = font(400, 12);
    ctx.fillText(row.label, gx + 10, gy + PAD_Y + 1);

    cells.forEach(({ cell, big, main, sub }, i) => {
      const x = gx + LABEL_W + i * COL_W;
      ctx.fillStyle = TONE_BG[cell.tone];
      ctx.fillRect(x, gy, COL_W, height);

      let ty = gy + PAD_Y;
      ctx.fillStyle = cell.color || TONE_FG[cell.tone];
      ctx.font = font(big ? 500 : 400, big ? 21 : 13);
      main.forEach((ln) => {
        ctx.fillText(ln, x + PAD_X, ty);
        ty += big ? 26 : LINE_H;
      });
      if (sub.length > 0) {
        ctx.fillStyle = big ? C_MUTED : "rgba(31,35,41,.62)";
        ctx.font = font(400, 11);
        sub.forEach((ln) => {
          ctx.fillText(ln, x + PAD_X, ty + 1);
          ty += 15;
        });
      }
    });

    // 行分隔线 + 列分隔线
    ctx.strokeStyle = C_LINE;
    ctx.beginPath();
    ctx.moveTo(gx, gy + height);
    ctx.lineTo(gx + gridW, gy + height);
    ctx.stroke();
    gy += height;
  });

  // 竖线
  for (let i = 0; i <= n; i++) {
    const x = gx + LABEL_W + i * COL_W;
    ctx.strokeStyle = C_LINE;
    ctx.beginPath();
    ctx.moveTo(x, headBlock);
    ctx.lineTo(x, headBlock + gridH);
    ctx.stroke();
  }

  // 网格外框必须最后描：单元格填色会盖住先画的边框
  ctx.strokeStyle = C_LINE;
  ctx.lineWidth = 1;
  roundRect(ctx, gx + 0.5, headBlock + 0.5, gridW - 1, gridH - 1, 8);
  ctx.stroke();

  // 页脚
  const ts = new Date().toLocaleString("zh-CN", { hour12: false });
  ctx.fillStyle = C_FAINT;
  ctx.font = font(400, 11);
  ctx.fillText(`由 人才 · AI 匹配生成 · ${ts}`, PAD, totalH - 30);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("生成图片失败"))), "image/png");
  });
}

/** 画完直接触发下载 */
export async function downloadMatrixPng(cols: MatrixCol[], title: string): Promise<void> {
  const blob = await renderMatrixPng(cols, title);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `人才对比-${title || "未命名"}-${stamp}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 交给浏览器把下载排上队再释放
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
