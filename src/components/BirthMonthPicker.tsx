import { useEffect, useMemo, useRef, useState } from "react";
import { Select, Space } from "antd";
import dayjs from "dayjs";

interface Props {
  /** 与 antd DatePicker 一样的语义：dayjs 对象 / null（清空） */
  value?: dayjs.Dayjs | null;
  onChange?: (v: dayjs.Dayjs | null) => void;
}

/**
 * 出生年月选择器：拆成「年 + 月」两个下拉。
 *
 * 为什么不用 antd 的 DatePicker picker="month"：
 * 那个面板顶部是「‹ 2026 ›」，点 ‹ 只退**一年**。要选 1994 年得连点 30 多次，
 * 是用户明确提过的痛点。换成两个下拉后，选 1994 是「输入 1994 回车」，一次搞定；
 * 月份本来就只有 12 个，下拉比翻日历快。
 *
 * 对外仍然只暴露一个 dayjs 值——Form 的字段名、提交格式、
 * 「选完年月实时算年龄」的逻辑全都不用动。
 */
export default function BirthMonthPicker({ value, onChange }: Props) {
  const [year, setYear] = useState<number | undefined>(value ? value.year() : undefined);
  const [month, setMonth] = useState<number | undefined>(value ? value.month() + 1 : undefined);

  // 「外部把值清空」和「用户只选了年、还没选月」都会让 value 变成 null。
  // 前者要把内部状态一起清掉，后者不能——否则选好的年份会被自己的联动清没。
  const skipSync = useRef(false);

  useEffect(() => {
    if (skipSync.current) {
      skipSync.current = false;
      return;
    }
    if (!value) {
      setYear(undefined);
      setMonth(undefined);
      return;
    }
    setYear(value.year());
    setMonth(value.month() + 1);
  }, [value]);

  const yearOptions = useMemo(() => {
    const now = dayjs().year();
    const list: { label: string; value: number }[] = [];
    for (let y = now; y >= 1950; y--) list.push({ label: `${y} 年`, value: y });
    return list;
  }, []);

  const monthOptions = useMemo(() => {
    const list: { label: string; value: number }[] = [];
    for (let m = 1; m <= 12; m++) list.push({ label: `${m} 月`, value: m });
    return list;
  }, []);

  const emit = (y?: number, m?: number) => {
    if (!y || !m) {
      // 年月没凑齐：对外就是「还没填完」，但内部要留住已选的那一半
      skipSync.current = true;
      onChange?.(null);
      return;
    }
    onChange?.(dayjs(`${y}-${String(m).padStart(2, "0")}-01`));
  };

  return (
    <Space.Compact style={{ width: "100%" }}>
      <Select
        style={{ width: "56%" }}
        placeholder="出生年"
        allowClear
        showSearch
        optionFilterProp="label"
        options={yearOptions}
        value={year}
        onChange={(v) => {
          const y = v ?? undefined;
          setYear(y);
          emit(y, month);
        }}
      />
      <Select
        style={{ width: "44%" }}
        placeholder="出生月"
        allowClear
        options={monthOptions}
        value={month}
        onChange={(v) => {
          const m = v ?? undefined;
          setMonth(m);
          emit(year, m);
        }}
      />
    </Space.Compact>
  );
}
