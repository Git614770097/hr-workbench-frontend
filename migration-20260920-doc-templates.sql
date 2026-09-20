-- 迁移：新增文档模板表 + 内置常用模板
-- 执行：npx wrangler d1 execute hr-workbench --remote --file=./migration-20260920-doc-templates.sql
-- 内置模板用固定 id + INSERT OR IGNORE，重复执行不会插重

CREATE TABLE IF NOT EXISTS doc_templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_doc_templates_category ON doc_templates(category);

-- ============ 内置模板（owner_id = 'system'）============

INSERT OR IGNORE INTO doc_templates (id, owner_id, name, category, content) VALUES (
'tpl-builtin-labor-contract', 'system', '劳动合同（通用版）', '劳动合同',
'劳 动 合 同 书

甲方（用人单位）：{{公司名称}}
法定代表人：{{法定代表人}}
地址：{{公司地址}}

乙方（劳动者）：{{姓名}}
性别：{{性别}}
身份证号码：{{身份证号}}
联系电话：{{手机号}}
住址：{{住址}}

根据《中华人民共和国劳动法》《中华人民共和国劳动合同法》及相关法律法规，甲乙双方本着平等自愿、协商一致的原则，签订本合同，共同遵守。

一、合同期限
本合同期限自 {{入职日期}} 起至 {{合同到期日}} 止，其中试用期自 {{入职日期}} 起至 {{试用期结束日}} 止。

二、工作内容与工作地点
1. 乙方同意在甲方 {{部门}} 部门担任 {{职位}} 岗位工作。
2. 工作地点：{{工作地点}}。

三、劳动报酬
1. 乙方试用期月工资为人民币 {{试用期薪资}} 元。
2. 试用期满转正后月工资为人民币 {{转正薪资}} 元。
3. 甲方每月 {{发薪日}} 日前以货币形式支付乙方工资。

四、社会保险与福利
甲方依法为乙方缴纳社会保险（养老、医疗、失业、工伤、生育保险）及住房公积金。

五、劳动纪律
乙方应遵守甲方依法制定的各项规章制度，服从甲方的工作安排和管理。

六、合同的解除与终止
双方解除或终止本合同，应依照《劳动合同法》的相关规定执行。

七、其他约定
{{其他约定}}

本合同一式两份，甲乙双方各执一份，自双方签字（盖章）之日起生效。

甲方（盖章）：{{公司名称}}          乙方（签字）：{{姓名}}

签订日期：{{日期}}'
);

INSERT OR IGNORE INTO doc_templates (id, owner_id, name, category, content) VALUES (
'tpl-builtin-resignation-cert', 'system', '离职证明', '离职证明',
'离 职 证 明

兹证明 {{姓名}}（身份证号：{{身份证号}}），于 {{入职日期}} 入职我公司，担任 {{部门}} 部门 {{职位}} 职务。

该员工因 {{离职原因}}，于 {{离职日期}} 与我公司正式解除（终止）劳动关系，已办理完毕全部离职交接手续。

该员工在职期间工作表现 {{工作表现}}，无未了结的经济纠纷及劳动争议。

特此证明。

本证明仅用于证明劳动关系解除（终止）事实，不作其他用途。

{{公司名称}}（盖章）

{{日期}}'
);

INSERT OR IGNORE INTO doc_templates (id, owner_id, name, category, content) VALUES (
'tpl-builtin-salary-adjust', 'system', '调薪通知书', '调薪通知',
'调 薪 通 知 书

尊敬的 {{姓名}} 员工：

鉴于您在工作中的出色表现和贡献，经公司研究决定，自 {{生效日期}} 起对您的薪资进行调整，具体如下：

一、调整前薪资：人民币 {{调整前薪资}} 元/月
二、调整后薪资：人民币 {{调整后薪资}} 元/月
三、调整幅度：{{调整幅度}}

调薪原因：{{调薪原因}}

希望您再接再厉，与公司共同成长。如对本次调薪有任何疑问，请与人力资源部联系。

您的现任岗位：{{部门}} {{职位}}

{{公司名称}}
人力资源部

{{日期}}'
);

INSERT OR IGNORE INTO doc_templates (id, owner_id, name, category, content) VALUES (
'tpl-builtin-warning-letter', 'system', '警告信', '警告信',
'警 告 信

{{姓名}}（工号：{{工号}}，部门：{{部门}}，职位：{{职位}}）：

经调查核实，您于 {{违纪日期}} 存在以下违纪行为：

{{违纪事实}}

上述行为违反了公司《{{制度名称}}》第 {{条款编号}} 条之规定，影响了正常的工作秩序。经公司研究决定，给予您 {{警告级别}} 处分，并予以书面警告。

请您自收到本警告信之日起 {{整改期限}} 日内完成整改。如再次发生类似行为，公司将依据规章制度给予进一步处理，直至解除劳动合同。

如您对本处分有异议，可在收到本警告信之日起 {{申诉期限}} 日内向人力资源部提出书面申诉。

员工签收：____________

{{公司名称}}
人力资源部

{{日期}}'
);

INSERT OR IGNORE INTO doc_templates (id, owner_id, name, category, content) VALUES (
'tpl-builtin-employment-cert', 'system', '在职证明', '在职证明',
'在 职 证 明

兹证明 {{姓名}}（身份证号：{{身份证号}}），系我公司正式员工，于 {{入职日期}} 入职至今，现任 {{部门}} 部门 {{职位}} 职务，月工资为人民币 {{月薪}} 元。

该员工目前在职状态正常，劳动合同期限至 {{合同到期日}}。

本证明仅用于 {{证明用途}} 之用，不作其他用途。

特此证明。

{{公司名称}}（盖章）
联系电话：{{公司电话}}

{{日期}}'
);
