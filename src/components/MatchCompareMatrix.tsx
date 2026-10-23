import { Fragment, useMemo, useState } from "react";
import { Button, Tooltip, message } from "antd";
import { DownloadOutlined, CaretUpOutlined, CaretDownOutlined, SwapOutlined } from "@ant-design/icons";
import { MATRIX_ROWS, MATRIX_MAX_COLS, type MatrixCol } from "../utils/matchMatrix";
import { downloadMatrixPng } from "../utils/matchMatrixImage";

interface Props {
  /** 已按匹配度从高到低排好 */
  cols: MatrixCol[];
  /** 画像名，用于标题与导出文件名 */
  title: string;
}

type SortState = { key: string; dir: "asc" | "desc" } | null;

/**
 * 候选人对比矩阵：维度做行、候选人做列（类似手机参数对比表）。
 *
 * 为什么是矩阵而不是柱状图：柱状图只能回答「谁分高」，回答不了「差在哪」——
 * 而 HR 做决定真正要的是「卡在哪个硬性条件、薪资多少、面试该问什么」。
 *
 * 规则：
 * - 最多显示 MATRIX_MAX_COLS 列（超过按当前排序取前 N，并在底部提示还有几人）
 * - 点带排序图标的维度名可切换 降序 → 升序 → 取消
 * - 导出的长图用 canvas 重绘（见 utils/matchMatrixImage），不是截图
 */
export default function MatchCompareMatrix({ cols, title }: Props) {
  const [sort, setSort] = useState<SortState>(null);
  const [exporting, setExporting] = useState(false);

  const shown = useMemo(() => {
    const row = sort ? MATRIX_ROWS.find((r) => r.key === sort.key) : null;
    const base =
      sort && row?.sortValue
        ? [...cols].sort((a, b) => (row.sortValue!(a) - row.sortValue!(b)) * (sort.dir === "asc" ? 1 : -1))
        : cols;
    return base.slice(0, MATRIX_MAX_COLS);
  }, [cols, sort]);

  const hidden = cols.length - shown.length;

  const toggleSort = (key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "desc" };
      if (prev.dir === "desc") return { key, dir: "asc" };
      return null;
    });
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      await downloadMatrixPng(shown, title);
      message.success("长图已生成，可直接转发给用人部门");
    } catch (e) {
      message.error(`导出失败：${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="mm">
      <div className="mm-head">
        <span className="mm-title">对比矩阵</span>
        <span className="mm-hint">
          维度做行、候选人做列 · 点维度名可排序 · 最多 {MATRIX_MAX_COLS} 列
        </span>
        <Tooltip title="生成一张可转发给用人部门的长图">
          <Button
            size="small"
            icon={<DownloadOutlined />}
            loading={exporting}
            onClick={handleExport}
            style={{ marginLeft: "auto" }}
          >
            导出长图
          </Button>
        </Tooltip>
      </div>

      <div className="mm-scroll">
        <div
          className="mm-grid"
          style={{ gridTemplateColumns: `88px repeat(${shown.length}, minmax(0, 1fr))` }}
        >
          {/* 表头 */}
          <div className="mm-corner" />
          {shown.map((c, i) => (
            <div className="mm-colhead" key={c.key}>
              <div className="mm-colhead-top">
                <span className={"mm-rank" + (i === 0 ? " is-top" : "")}>{i + 1}</span>
                <span className="mm-colname" title={c.name}>{c.name}</span>
              </div>
              <div className="mm-colsub" title={c.sub}>{c.sub}</div>
            </div>
          ))}

          {/* 维度行 */}
          {MATRIX_ROWS.map((row) => {
            const sortable = !!row.sortValue;
            const active = sort?.key === row.key;
            return (
              <Fragment key={row.key}>
                <div
                  className={"mm-label" + (sortable ? " is-sortable" : "") + (active ? " is-active" : "")}
                  onClick={sortable ? () => toggleSort(row.key) : undefined}
                  title={sortable ? "点击排序" : undefined}
                >
                  <span>{row.label}</span>
                  {sortable && (
                    <span className="mm-sorticon">
                      {!active ? <SwapOutlined /> : sort!.dir === "desc" ? <CaretDownOutlined /> : <CaretUpOutlined />}
                    </span>
                  )}
                </div>
                {shown.map((c) => {
                  const cell = row.cell(c);
                  return (
                    <div
                      className={`mm-cell is-${cell.tone}${cell.big ? " is-big" : ""}`}
                      key={c.key}
                    >
                      <span className="mm-main" style={cell.color ? { color: cell.color } : undefined}>
                        {cell.main}
                      </span>
                      {cell.sub && <span className="mm-sub">{cell.sub}</span>}
                    </div>
                  );
                })}
              </Fragment>
            );
          })}
        </div>
      </div>

      {hidden > 0 && (
        <div className="mm-more">
          还有 {hidden} 位未显示（最多 {MATRIX_MAX_COLS} 列）· 换排序或减少候选人可看到
        </div>
      )}
    </div>
  );
}
