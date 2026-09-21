import { Modal } from "antd";
import TagManagerContent from "./TagManagerContent";

interface Props {
  open: boolean;
  onClose: () => void;
}

// 标签管理弹窗：从「人才库」页工具栏入口打开。
// 标签是低频配置项，不再占用侧栏一级菜单。
export default function TagManagerModal({ open, onClose }: Props) {
  return (
    <Modal
      title="标签管理"
      open={open}
      onCancel={onClose}
      footer={null}
      width={880}
      destroyOnClose
    >
      <TagManagerContent />
    </Modal>
  );
}
