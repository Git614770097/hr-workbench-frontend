import { useState, useEffect } from "react";
import {
  Card, Table, Tag as AntTag, Popconfirm, message, Button, Space,
} from "antd";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { Tag, User } from "../types";
import TagFormModal from "../components/TagFormModal";

export default function Tags() {
  const [tags, setTags] = useState<(Tag & { talent_count?: number; owner_name?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<(Tag & { talent_count?: number }) | null>(null);

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";

  const fetchTags = async () => {
    try {
      const res = await api.getTags();
      setTags(res);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  useEffect(() => { fetchTags(); }, []);

  const handleDelete = async (id: string, tagName: string) => {
    try {
      await api.deleteTag(id);
      message.success(`已删除「${tagName}」`);
      fetchTags();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const openCreate = () => {
    setEditingTag(null);
    setModalOpen(true);
  };

  const openEdit = (tag: Tag & { talent_count?: number }) => {
    setEditingTag(tag);
    setModalOpen(true);
  };

  const columns = [
    {
      title: "标签",
      dataIndex: "name",
      key: "name",
      render: (text: string, record: Tag) => (
        <AntTag color={record.color} style={{ fontSize: 14, padding: "4px 12px" }}>{text}</AntTag>
      ),
    },
    {
      title: "颜色",
      dataIndex: "color",
      key: "color",
      width: 200,
      render: (c: string) => <div style={{ width: 24, height: 24, borderRadius: "50%", background: c }} />,
    },
    {
      title: "关联人才数",
      dataIndex: "talent_count",
      key: "talent_count",
      width: 100,
      render: (v: number) => v || 0,
    },
    ...(isAdmin ? [{
      title: "创建人",
      dataIndex: "owner_name",
      key: "owner_name",
      width: 90,
      render: (v: string) => v || "—",
    }] : []),
    {
      title: "操作",
      key: "action",
      width: 150,
      render: (_: any, record: Tag & { talent_count?: number }) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id, record.name)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增标签</Button>
      </div>

      <Card>
        <Table
          columns={columns}
          dataSource={tags}
          rowKey="id"
          loading={loading}
          pagination={false}
        />
      </Card>

      {/* 新增/编辑标签弹窗 */}
      <TagFormModal
        open={modalOpen}
        tag={editingTag}
        onClose={() => setModalOpen(false)}
        onSuccess={fetchTags}
      />
    </div>
  );
}
