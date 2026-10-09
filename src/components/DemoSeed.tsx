import { useState } from "react";
import { Alert, Button, Modal, message } from "antd";
import { PlayCircleOutlined, ClearOutlined } from "@ant-design/icons";
import { api } from "../api";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";

/**
 * 示例数据（演示模式）共用件：
 * - DemoSeedButton：空状态里的「载入示例数据」按钮（确认后 seed，回调刷新列表）
 * - DemoBanner：列表包含示例数据时显示的提示条，带「一键清除」
 * 示例数据全部打 is_demo=1，清除只动标记数据，绝不碰用户录入的真实数据。
 */

export function DemoSeedButton({ onDone, block }: { onDone: () => void; block?: boolean }) {
  const [loading, setLoading] = useState(false);
  const profile = useIdentityProfile();
  const seed = () => {
    Modal.confirm({
      title: "载入示例数据？",
      content: termFor(
        profile,
        "将生成 3 个岗位、13 位候选人（覆盖看板各阶段与招聘漏斗）和 3 条待办，" +
        "帮你快速了解系统怎么用。示例数据可随时一键清除，不影响你录入的真实数据。"
      ),
      okText: "载入示例数据",
      cancelText: "取消",
      onOk: async () => {
        setLoading(true);
        try {
          const r = await api.seedDemo();
          message.success(
            termFor(profile, `已载入示例数据：${r.seeded.jobs} 个岗位、${r.seeded.talents} 位候选人、${r.seeded.tasks} 条待办`)
          );
          onDone();
        } catch (e) {
          message.error((e as Error).message || "载入失败，请稍后重试");
        } finally {
          setLoading(false);
        }
      },
    });
  };
  return (
    <Button type="primary" icon={<PlayCircleOutlined />} loading={loading} onClick={seed} block={block}>
      载入示例数据
    </Button>
  );
}

/** 列表含示例数据时的提示条：some(is_demo) 即显示，一键清除后回调刷新 */
export function DemoBanner({
  items,
  onChanged,
}: {
  items: { is_demo?: number }[];
  onChanged: () => void;
}) {
  const [clearing, setClearing] = useState(false);
  const profile = useIdentityProfile();
  if (!items.some((t) => t.is_demo)) return null;
  const clear = () => {
    Modal.confirm({
      title: "清除全部示例数据？",
      content: termFor(profile, "将删除所有标记为「示例」的岗位、候选人、投递记录与待办；你录入的真实数据不受影响。"),
      okText: "清除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        setClearing(true);
        try {
          const r = await api.clearDemo();
          message.success(termFor(profile, `已清除示例数据：${r.removed.talents} 位候选人、${r.removed.jobs} 个岗位`));
          onChanged();
        } catch (e) {
          message.error((e as Error).message || "清除失败，请稍后重试");
        } finally {
          setClearing(false);
        }
      },
    });
  };
  return (
    <Alert
      type="info"
      showIcon
      icon={<PlayCircleOutlined />}
      style={{ marginBottom: 12 }}
      message="当前包含示例数据，供你快速了解系统"
      description={termFor(profile, "示例数据覆盖岗位、看板、漏斗与待办，可随意编辑把玩；正式使用前点右侧按钮一键清除，不会影响你录入的真实数据。")}
      action={
        <Button size="small" danger icon={<ClearOutlined />} loading={clearing} onClick={clear}>
          清除示例数据
        </Button>
      }
    />
  );
}
