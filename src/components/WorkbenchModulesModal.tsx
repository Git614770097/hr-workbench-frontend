import { Modal, Checkbox, Button, Space, Tooltip } from "antd";
import { UndoOutlined, CrownOutlined, UserOutlined } from "@ant-design/icons";
import type { WorkbenchModuleKey } from "../types";
import { WORKBENCH_MODULES, presetHidden } from "../workbenchPrefs";

interface Props {
  open: boolean;
  onClose: () => void;
  hidden: WorkbenchModuleKey[];
  /** 立即生效（父组件负责持久化） */
  onChange: (hidden: WorkbenchModuleKey[]) => void;
}

/**
 * 工作台「调整模块」：控制各卡片显隐。
 * 每个人关注的数据不一样 —— 招聘专员偏漏斗过程，管理者偏结果指标。
 * 配置存后端用户设置（user_settings.workbench_modules），换设备也同步。
 */
export default function WorkbenchModulesModal({ open, onClose, hidden, onChange }: Props) {
  const toggle = (key: WorkbenchModuleKey, checked: boolean) => {
    const set = new Set(hidden);
    if (checked) set.delete(key);
    else set.add(key);
    onChange([...set]);
  };

  const groups: { zone: "action" | "analysis"; title: string; tip: string }[] = [
    { zone: "action", title: "行动层（首屏）", tip: "进门先看到「今天要做什么」" },
    { zone: "analysis", title: "分析层（下滚）", tip: "招聘概览数据与图表" },
  ];

  return (
    <Modal
      title="调整模块"
      open={open}
      onCancel={onClose}
      footer={<Button type="primary" onClick={onClose}>完成</Button>}
      width={460}
      destroyOnClose
    >
      <div className="wb-mod-intro">
        勾选要显示的模块。配置会保存到你的账号，换设备登录也保持一致。
      </div>

      <Space wrap size={8} style={{ marginBottom: 16 }}>
        <Tooltip title="收起「渠道效果 / 淘汰原因」等执行细节，突出结果指标">
          <Button size="small" icon={<CrownOutlined />} onClick={() => onChange(presetHidden("manager"))}>
            管理者视图
          </Button>
        </Tooltip>
        <Tooltip title="全部显示，便于盯过程与漏斗细节">
          <Button size="small" icon={<UserOutlined />} onClick={() => onChange(presetHidden("recruiter"))}>
            招聘视图
          </Button>
        </Tooltip>
        <Button size="small" icon={<UndoOutlined />} onClick={() => onChange([])}>
          全部显示
        </Button>
      </Space>

      {groups.map((g) => (
        <div className="wb-mod-group" key={g.zone}>
          <div className="wb-mod-group-head">
            <span className="wb-mod-group-title">{g.title}</span>
            <span className="wb-mod-group-tip">{g.tip}</span>
          </div>
          <div className="wb-mod-list">
            {WORKBENCH_MODULES.filter((m) => m.zone === g.zone).map((m) => (
              <label className="wb-mod-item" key={m.key}>
                <Checkbox
                  checked={!hidden.includes(m.key)}
                  onChange={(e) => toggle(m.key, e.target.checked)}
                />
                <span className="wb-mod-item-body">
                  <span className="wb-mod-item-label">{m.label}</span>
                  <span className="wb-mod-item-desc">{m.desc}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </Modal>
  );
}
