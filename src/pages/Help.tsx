import { Card, Collapse, Divider, Typography } from "antd";
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import {
  RocketOutlined,
  DatabaseOutlined,
  FunnelPlotOutlined,
  RobotOutlined,
  FileProtectOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { useCurrentUser, useIdentityProfile } from "../useIdentity";
import { termFor, type IdentityProfile } from "../identityProfiles";
import { canAccessPath } from "../utils/routeAccess";

const { Title, Paragraph, Text } = Typography;

/**
 * 帮助中心：分类手风琴 FAQ。
 * 内容基于系统真实功能与使用中沉淀的说明（如漏斗「曾到达」口径、
 * 渠道来源依赖、扫描件日期降级手填等），帮助新用户快速建立正确预期。
 *
 * 身份适配（两层，都不改鉴权）：
 * 1. 分类级：visibleWhen 声明该分类需要哪个菜单权限，无权限整块隐藏
 *    —— 猎头看不到「合同与社保」的 FAQ，也不会读到与己无关的模块说明；
 * 2. 文案级：所有文本经 termFor 按身份替换（人才→候选人、岗位→职位…），
 *    与菜单、页面内术语保持一致。
 */

interface QA {
  q: string;
  a: ReactNode;
}

interface Category {
  key: string;
  label: string;
  icon: ReactNode;
  /** 该分类涉及的桌面菜单路径；用户可访问其中任意一个即显示。不传=始终显示 */
  visibleWhen?: string[];
  items: QA[];
}

const CATEGORIES: Category[] = [
  {
    key: "start",
    label: "快速上手",
    icon: <RocketOutlined />,
    items: [
      {
        q: "这个系统是做什么的？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            一套面向招聘业务的人才管理系统，覆盖「人才从入库到入职」的全过程：建立岗位、沉淀人才库、AI 画像与智能匹配、流程看板推进、转化复盘与到期跟进。
            不含员工花名册、薪资绩效等入职之后的模块。不同角色开放的模块以侧栏菜单为准（见下方「账号与权限」）。
          </Paragraph>
        ),
      },
      {
        q: "第一次使用，推荐的上手路径？",
        a: (
          <>
            <Paragraph type="secondary" style={{ marginBottom: 4 }}>
              建议按招聘的实际顺序走一遍：
            </Paragraph>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li><Text type="secondary">「岗位管理」创建在招岗位</Text></li>
              <li><Text type="secondary">「人才画像」新建画像：填目标职位 → AI 生成 JD → AI 生成画像 → 保存</Text></li>
              <li><Text type="secondary">「人才库管理」录入或批量导入简历</Text></li>
              <li><Text type="secondary">「人才库管理」工具栏进入智能匹配，挑出合适候选人</Text></li>
              <li><Text type="secondary">「招聘看板」推进候选人阶段</Text></li>
              <li><Text type="secondary">「招聘概览」查看各环节转化与渠道效果</Text></li>
            </ul>
            <Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>
              也可以先在人才库、岗位或招聘流程的空状态页点「载入示例数据」，用一套演示数据熟悉各页面，随时可一键清除，不影响真实数据。
            </Paragraph>
          </>
        ),
      },
      {
        q: "新建人才画像的正确姿势？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            三步：① 填「目标职位」；② 点「AI 生成 JD」；③ 点「AI 生成画像」。AI 结果会落在弹窗下方的「画像字段」区，可手动修改后再保存。只填职位不点后两个 AI 按钮，画像内容不会自动出现。
          </Paragraph>
        ),
      },
      {
        q: "批量导入简历怎么操作？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            人才库 → 「导入简历」→ 拖入 PDF / Word 文件 → 系统逐份解析后弹出核对窗口，确认字段无误后保存录入。同一批简历可在导入窗口顶部统一选择「本批来源渠道」，避免来源漏记。
          </Paragraph>
        ),
      },
      {
        q: "如何重看新手指引？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            点击页面右上角的 <Text strong>?</Text> 按钮，选择「重看新手指引」即可在当前页面重新播放。
          </Paragraph>
        ),
      },
    ],
  },
  {
    key: "talents",
    label: "人才库",
    icon: <DatabaseOutlined />,
    visibleWhen: ["/talents"],
    items: [
      {
        q: "人才库支持哪些搜索条件？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            列表顶部支持姓名、手机号、应聘职位、当前阶段、状态等常用字段的组合搜索，多个条件之间是「且」的关系。
          </Paragraph>
        ),
      },
      {
        q: "为什么「来源渠道」字段很重要？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            渠道来源统计（见「招聘概览」页）完全依赖这个字段。录入或导入时没有记录来源的候选人会计入「未记录」，占比过高时系统会提示统计可能失真。新导入的简历可在导入时统一选择来源，存量数据可在人才编辑弹窗中补录。
          </Paragraph>
        ),
      },
      {
        q: "删除人才会删掉什么？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            该人才的阶段轨迹、应聘岗位记录会一并删除，关联的跟进待办会解除关联，且操作不可恢复，请谨慎执行。
          </Paragraph>
        ),
      },
      {
        q: "示例数据是什么？会影响真实数据吗？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            示例数据是一套带特殊标记的演示数据（人才、岗位、完整的阶段流转轨迹），用于系统刚开通时熟悉功能。载入后各页面顶部会出现提示条，点「清除示例数据」可整体移除，全程不会触碰真实数据，真实数据与示例数据可并存展示。
          </Paragraph>
        ),
      },
    ],
  },
  {
    key: "funnel",
    label: "看板与概览",
    icon: <FunnelPlotOutlined />,
    visibleWhen: ["/pipeline", "/funnel"],
    items: [
      {
        q: "招聘概览的数字为什么和「当前在招人数」对不上？",
        a: (
          <>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              漏斗按「曾到达」口径统计：只要候选人曾经进入过某个阶段，即使后来被淘汰或主动放弃，仍计入该阶段人数。因此漏斗各层人数单调递减，反映的是流程各环节的到达与流失情况，而不是某个时刻的实时在招人数。
            </Paragraph>
          </>
        ),
      },
      {
        q: "平均周期看起来偏高 / 偏低？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            均值容易被个别长尾案例拉偏，请同时关注中位数（p50）与 p90，它们更能代表「典型候选人」的耗时。渠道效果表中的「平均周期」仅统计已入职的候选人，未入职的样本不计入。
          </Paragraph>
        ),
      },
      {
        q: "渠道效果表怎么理解？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            按「人·岗位」口径统计：同一位候选人投递多个岗位会分别计数。每条渠道包含进入人数、入职、进行中、淘汰、放弃与平均周期，可用来对比各渠道的「量」（进入人数）与「质」（入职率、周期）。表格右上角可导出 CSV 做进一步分析。
          </Paragraph>
        ),
      },
      {
        q: "候选人阶段流转错了怎么办？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            在「招聘看板」把候选人拖回或移动到正确阶段即可，历史轨迹会完整保留，漏斗统计以轨迹为准，不会因为移错再移回而产生重复计数。
          </Paragraph>
        ),
      },
    ],
  },
  {
    key: "ai",
    label: "AI 功能",
    icon: <RobotOutlined />,
    items: [
      {
        q: "系统里有哪些 AI 能力？",
        a: (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li><Text type="secondary">人才画像页：「AI 生成 JD」「AI 生成画像」</Text></li>
            <li><Text type="secondary">导入简历：自动解析简历内容并填入核对弹窗</Text></li>
            <IfPerm any={["/contracts"]}>
              <li><Text type="secondary">合同管理：从合同文件中智能提取签订日期</Text></li>
            </IfPerm>
          </ul>
        ),
      },
      {
        q: "AI 解析简历不准或失败怎么办？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            解析结果都会先进入核对弹窗，逐项确认或修改后再保存即可；个别排版复杂的简历解析失败时，可直接在核对弹窗中手动填写。AI 接口响应最长约一分钟，点击后请耐心等待。
          </Paragraph>
        ),
      },
      {
        q: "AI 生成的画像可以直接用吗？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            AI 结果只是初稿，会落在弹窗的「画像字段」区，保存前可以任意修改。建议把 AI 生成的内容当作起点，结合岗位实际情况调整后再保存。
          </Paragraph>
        ),
      },
    ],
  },
  {
    key: "contract",
    label: "合同与社保",
    icon: <FileProtectOutlined />,
    visibleWhen: ["/contracts", "/social"],
    items: [
      {
        q: "合同管理能做什么？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            集中查看各人才的合同与试用期信息：上传合同原件、记录合同起止日期、试用期等。临近到期的合同会出现在提醒列表中，配合消息推送可提前收到通知。
          </Paragraph>
        ),
      },
      {
        q: "上传合同后日期识别失败？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            合同是扫描件或纯图片时，系统无法从文件中提取文字日期，此时会提示手动填写。文字版 PDF / Word 文档一般可自动识别。
          </Paragraph>
        ),
      },
      {
        q: "社保公积金台账记什么？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            记录参保状态、缴费基数与比例，办理增减员时会联动生成跟进待办，在「跟进待办」页可查看与处理。
          </Paragraph>
        ),
      },
      {
        q: "到期提醒怎么收到？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            配置 PushPlus 消息推送后（见「账号与权限」分类），跟进待办与合同 / 试用期到期提醒会推送到你的微信，无需一直盯着系统。
          </Paragraph>
        ),
      },
    ],
  },
  {
    key: "account",
    label: "账号与权限",
    icon: <SafetyCertificateOutlined />,
    items: [
      {
        q: "如何注册账号？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            登录页支持自助注册，提交后需管理员审批通过才能登录。忘记密码可通过登录页的「忘记密码」自助重置。
          </Paragraph>
        ),
      },
      {
        q: "为什么我看不到某个菜单？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            各菜单按角色权限显示，由管理员在「角色管理」中分配。无权限的菜单不会出现在侧栏，如需开通请联系管理员调整角色权限。
          </Paragraph>
        ),
      },
      {
        q: "消息推送（PushPlus）怎么配置？",
        a: (
          <>
            <Paragraph type="secondary" style={{ marginBottom: 4 }}>
              点击右上角头像 → 「消息推送设置」→ 按引导获取并填入 PushPlus token 即可。两点说明：
            </Paragraph>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li><Text type="secondary">PushPlus 需完成微信实名认证后才能正常接收推送</Text></li>
              <li><Text type="secondary">跟进待办只推送给负责人本人；合同 / 试用期到期提醒会推送给所有已配置推送的用户</Text></li>
            </ul>
          </>
        ),
      },
      {
        q: "如何邀请同事使用？",
        a: (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            请同事在登录页自助注册，然后管理员在「用户管理」中审批通过并为其分配角色即可。
          </Paragraph>
        ),
      },
    ],
  },
];

/** 仅在用户可访问 any 中任一菜单时渲染（用于 FAQ 里按模块分条的条目） */
function IfPerm({ any, children }: { any: string[]; children: ReactNode }) {
  const user = useCurrentUser();
  const ok = any.some((p) => canAccessPath(user, p));
  return ok ? <>{children}</> : null;
}

/**
 * 递归把 React 树里的字符串文本过一遍 termFor。
 * FAQ 答案是 JSX（含列表、加粗），无法对整块做字符串替换，
 * 因此渲染时遍历到文本叶子逐个替换 —— 内容是静态的，克隆安全。
 */
function termify(node: ReactNode, profile: IdentityProfile): ReactNode {
  if (typeof node === "string") return termFor(profile, node);
  if (Array.isArray(node)) {
    return node.map((child, i) => <Fragment key={i}>{termify(child, profile)}</Fragment>);
  }
  if (isValidElement(node)) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (el.props.children === undefined) return el;
    return cloneElement(el, undefined, termify(el.props.children, profile));
  }
  return node;
}

export default function Help() {
  const brand = useIdentityProfile();
  const user = useCurrentUser();

  // 按权限隐藏整块分类：无权访问的模块，其 FAQ 对用户只会造成困扰
  const categories = CATEGORIES.filter(
    (cat) => !cat.visibleWhen || cat.visibleWhen.some((p) => canAccessPath(user, p)),
  );

  return (
    <div className="help-page" style={{ maxWidth: 900, margin: "0 auto" }}>
      <Card styles={{ body: { padding: 24 } }}>
        <Title level={4} style={{ marginTop: 0, marginBottom: 8 }}>
          帮助中心
        </Title>
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          常见问题与使用说明。首次使用建议先看「快速上手」；点击右上角 <Text strong>?</Text> 按钮可随时重看新手指引。
        </Paragraph>
        <Collapse
          defaultActiveKey={["start"]}
          items={categories.map((cat) => ({
            key: cat.key,
            label: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {cat.icon}
                <span style={{ fontWeight: 600 }}>{termFor(brand, cat.label)}</span>
                <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                  {cat.items.length} 个问题
                </Text>
              </span>
            ),
            children: cat.items.map((qa, i) => (
              <div key={i}>
                <Paragraph strong style={{ marginBottom: 6 }}>
                  {termFor(brand, qa.q)}
                </Paragraph>
                <div>{termify(qa.a, brand)}</div>
                {i < cat.items.length - 1 && <Divider style={{ margin: "16px 0" }} />}
              </div>
            )),
          }))}
        />
      </Card>
    </div>
  );
}
