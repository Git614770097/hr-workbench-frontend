import { Card } from "antd";
import RequisitionPanel from "../components/RequisitionPanel";
import type { User } from "../types";

export default function Requisitions() {
  const currentUser: User | null = (() => {
    try {
      return JSON.parse(localStorage.getItem("user") || "null");
    } catch {
      return null;
    }
  })();
  const isAdmin = currentUser?.role === "admin";

  return (
    <div className="page-fill profiles-page">
      <Card className="list-card">
        {/* 招聘需求独立成页：用人部门提需求 → HR 审批 → 一键转正式岗位。
            岗位管理页的「提交招聘需求」按钮会跳转到这里（两个模块通过导航互链）。 */}
        <RequisitionPanel isAdmin={isAdmin} />
      </Card>
    </div>
  );
}
