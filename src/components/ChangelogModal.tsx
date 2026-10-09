import { useEffect, useState } from "react";
import { Modal, Button, Typography } from "antd";
import { api } from "../api";

// 本地已读版本号：与 site_settings 里的 changelog.version 比对，不同则弹窗
const SEEN_KEY = "seen_changelog_version";

interface Changelog {
  version: string | null;
  title: string | null;
  updated_at: string | null;
  items: string[];
}

/**
 * 更新公告弹窗：挂载即拉取 changelog，version 与本地已读版本不同则弹一次。
 * 关闭即把该 version 写入 localStorage，下次同版本不再打扰。
 * 异步加载、失败静默，绝不阻塞首屏。
 */
export default function ChangelogModal() {
  const [data, setData] = useState<Changelog | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getChangelog()
      .then((c) => {
        if (!alive) return;
        const seen = localStorage.getItem(SEEN_KEY);
        if (c && c.version && c.version !== seen) {
          setData(c);
          setOpen(true);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const close = () => {
    if (data?.version) localStorage.setItem(SEEN_KEY, data.version);
    setOpen(false);
  };

  if (!data) return null;

  return (
    <Modal
      open={open}
      title={data.title || `更新公告 ${data.version || ""}`}
      onOk={close}
      onCancel={close}
      footer={[
        <Button key="ok" type="primary" onClick={close}>
          我知道了
        </Button>,
      ]}
      destroyOnClose
    >
      {data.updated_at ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          更新于 {data.updated_at}
        </Typography.Text>
      ) : null}
      <ul style={{ paddingLeft: 18, margin: data.updated_at ? "8px 0 0" : 0 }}>
        {data.items.map((it, i) => (
          <li key={i} style={{ marginBottom: 6, lineHeight: 1.6 }}>
            {it}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
