// 浏览器端文件相关的通用小工具（导出下载）。
// HTML 转义 escapeHtml 抽到 utils/escapeHtml.ts（前端与 Worker 共用），此处 re-export 保持旧引用不变。
export { escapeHtml } from "./escapeHtml";

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 导出文件名用的本地时间戳：20260925_1603 */
export function dateStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** CSV 字段转义：含逗号/引号/换行的字段用双引号包裹，内部引号翻倍 */
export function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Excel 导出：多 sheet、带表头样式。exceljs 动态导入，不影响首屏体积。 */
export interface XlsxSheet {
  name: string;
  columns: { header: string; key: string; width?: number }[];
  rows: Record<string, string | number | null | undefined>[];
}

export async function exportXlsx(filename: string, sheets: XlsxSheet[]) {
  // 动态导入：exceljs 约 300KB，只在用户点「导出 Excel」时才加载
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    ws.columns = sheet.columns.map((col) => ({
      header: col.header,
      key: col.key,
      width: col.width ?? 18,
    }));
    // 表头加粗 + 浅灰底色
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF0F0F0" },
    };
    // 冻结表头行
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const row of sheet.rows) {
      ws.addRow(row);
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
}
