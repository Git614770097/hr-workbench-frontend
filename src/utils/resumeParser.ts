// 简历解析纯函数模块
// 从 PDF/Word 提取的纯文本中，结构化提取人才字段。
// 设计原则：标签式标注优先，全文兜底；正则尽量宽松兼容多种简历格式。

// ---------------------------------------------------------------------------
// 学历映射
// ---------------------------------------------------------------------------

// 学历关键词（按优先级从高到低）。注意：顺序很关键，越具体越靠前。
// 例如"硕士研究生"里同时含"硕士"和"研究生"，二者都映射到"硕士"，无冲突；
// 但"本科"必须排在"博士"之后、且要在"大专/专科"之前，避免"专升本"等误判。
// 英文写法放最后，避免与中文冲突（如 "Master of Science" 里的 Master）。
const EDUCATION_KEYWORDS: [string, string][] = [
  ["博士后", "博士"],
  ["博士", "博士"],
  ["MBA", "MBA/EMBA"],
  ["EMBA", "MBA/EMBA"],
  ["硕士", "硕士"],
  ["研究生", "硕士"],
  ["学士", "本科"],
  ["本科", "本科"],
  ["专升本", "本科"],
  ["大专", "大专"],
  ["专科", "大专"],
  ["中专", "中专"],
  ["技校", "中专"],
  ["职高", "中专"],
  ["高中", "高中及以下"],
  ["初中", "高中及以下"],
  ["小学", "高中及以下"],
  ["PhD", "博士"],
  ["Ph.D", "博士"],
  ["Doctor", "博士"],
  ["Master", "硕士"],
  ["Bachelor", "本科"],
  ["Associate", "大专"],
  ["High School", "高中及以下"],
];

export function normalizeEducation(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  // 先按中文关键词（大小写不敏感的英文单独处理）
  for (const [kw, mapped] of EDUCATION_KEYWORDS) {
    // 英文关键词用大小写不敏感匹配，中文用精确包含
    if (/[A-Za-z]/.test(kw)) {
      if (new RegExp(kw, "i").test(s)) return mapped;
    } else if (s.includes(kw)) {
      return mapped;
    }
  }
  // 无法识别时返回空，让用户手动选择（而非把原文塞进去造成脏数据）
  return "";
}

// ---------------------------------------------------------------------------
// 文本预清洗
// ---------------------------------------------------------------------------

// 统一全角/半角标点，方便正则匹配
function normalizeText(text: string): string {
  return text
    .replace(/[：]/g, ":")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[，]/g, ",")
    .replace(/[；]/g, ";")
    .replace(/[　]/g, " ")
    .replace(/[“”"]/g, '"')
    .replace(/[‘’]/g, "'");
}

// ---------------------------------------------------------------------------
// 姓名
// ---------------------------------------------------------------------------

// 常见城市（extractCity 依赖其顺序：全文兜底时取第一个命中的）
const CITIES = [
  "北京", "上海", "广州", "深圳", "杭州", "成都", "武汉", "南京", "西安", "苏州",
  "天津", "重庆", "长沙", "青岛", "厦门", "郑州", "合肥", "福州", "济南", "大连",
  "宁波", "无锡", "佛山", "东莞", "昆明", "沈阳", "哈尔滨", "长春", "石家庄",
  "南昌", "贵阳", "南宁", "兰州", "太原", "乌鲁木齐", "呼和浩特", "银川", "西宁",
  "海口", "三亚", "珠海", "惠州", "中山", "泉州", "温州", "嘉兴", "绍兴", "台州",
  "金华", "常州", "南通", "徐州", "扬州", "烟台", "潍坊", "淄博",
];

// 省/自治区/直辖市名（含简称）
const PROVINCES = [
  "广东", "广西", "江苏", "浙江", "山东", "河南", "河北", "湖南", "湖北", "四川",
  "福建", "安徽", "江西", "陕西", "山西", "云南", "贵州", "辽宁", "吉林", "黑龙江",
  "甘肃", "青海", "海南", "新疆", "西藏", "内蒙古", "宁夏", "台湾",
];

/** 地名（城市/省份）不是姓名。简历头部常出现「现居：广州」或独立一行的城市名，
 *  而"广州"恰好是 2 个汉字、能通过 NAME_RE，会被误当成姓名。
 *  也被 src/utils/fieldSanity.ts 复用（校验 AI 返回值）。 */
export function isPlaceName(s: string): boolean {
  if (CITIES.includes(s) || PROVINCES.includes(s)) return true;
  // 带行政区划后缀的短地名，如"佛山市"、"白云区"
  return s.length <= 4 && /[市省区县州盟旗]$/.test(s);
}

const NAME_BLACKLIST = new Set([
  "简历", "个人简历", "求职简历", "应聘简历", "我的简历", "电子简历",
  "基本信息", "个人信息", "个人信息表", "个人资料", "基本资料",
  "求职意向", "求职方向", "应聘岗位", "应聘职位", "期望职位", "期望岗位",
  "自我评价", "工作经历", "工作经验", "教育经历", "教育背景", "项目经验", "项目经历",
  "技能特长", "专业技能", "联系方式", "联系信息", "联系电话", "手机号",
  "先生", "女士", "姓名", "名字", "性别", "年龄", "民族", "籍贯", "政治面貌",
  "出生", "生日", "现居", "居住地", "邮箱", "电话", "微信", "期望薪资",
  "岗位", "职位", "在校生", "应届生", "求职者", "候选人", "应聘者",
  // 学历词（避免 headLines 扫描时把"本科/硕士"当姓名）
  "博士", "硕士", "本科", "大专", "专科", "中专", "高中", "初中", "小学",
  "研究生", "博士后", "学士", "学历", "学位",
  // 4 字章节词（NAME_RE 允许 2-4 字，这些短章节词会被误当姓名）
  "个人优势", "个人评价", "自我介绍", "自我描述", "工作职责", "项目描述",
  "专业技能", "技能清单", "荣誉奖项", "获奖情况", "校园经历", "实习经历",
  "培训经历", "兴趣爱好", "工作内容", "项目职责", "教育经历", "工作经历",
]);

// 姓名：2-4 个汉字，允许中间点（·）
const NAME_RE = /^[\u4e00-\u9fa5]{2,4}$/;
const NAME_RE_DOT = /^[\u4e00-\u9fa5]{1,3}·[\u4e00-\u9fa5]{1,3}$/;

function isNameToken(s: string): boolean {
  if (!s) return false;
  if (NAME_BLACKLIST.has(s)) return false;
  if (s.includes("简历")) return false;
  if (s.includes("求职") || s.includes("应聘")) return false;
  if (isPlaceName(s)) return false;
  if (NAME_RE.test(s)) return true;
  if (NAME_RE_DOT.test(s)) return true;
  return false;
}

export function extractName(text: string): string {
  const t = normalizeText(text);

  // 0. 少数民族/复姓带间隔号的姓名优先整体匹配（如"欧阳·娜娜"、"阿依古丽·买买提"）
  //    必须在其他正则之前，避免贪婪匹配从"·"后截断成"阳·娜娜"。
  const dotted = t.match(/([\u4e00-\u9fa5]{1,3}·[\u4e00-\u9fa5]{1,3})/);
  if (dotted && isNameToken(dotted[1])) return dotted[1];

  // 1. 标签式："姓名:张三" / "姓名 张三" / "姓名：张三 男" / "Name: Zhang San"
  const label = t.match(/(?:姓名|名字)\s*[:：]?\s*([\u4e00-\u9fa5·]{2,4})/);
  if (label && isNameToken(label[1])) return label[1];

  // 2. "张三(男)" / "张三 男" 式（姓名紧跟性别，是简历最典型的姓名位置）
  //    用 [ \t] 而非 \s，避免跨行把"工程师\n男"误连成姓名。
  const gender = t.match(/([\u4e00-\u9fa5·]{2,4})[ \t]*[（(][ \t]*(?:男|女)[ \t]*[）)]/) ||
    t.match(/([\u4e00-\u9fa5·]{2,4})[ \t]+(?:男|女)(?=[\s,，;；]|$)/m);
  if (gender && isNameToken(gender[1])) return gender[1];

  // 3. 手机号前的中文姓名（"张三 13800138000" / "张三 男 138..."）
  //    用 [ \t]* 限制在同一行，避免跨行误匹配（如"工程师\n13800004444"）。
  const beforePhone = t.match(/([\u4e00-\u9fa5·]{2,4})[ \t]*(?:[（(][男女][）)])?[ \t]*1[3-9][\d\s-]{9,12}/);
  if (beforePhone && isNameToken(beforePhone[1])) return beforePhone[1];

  // 4. 邮箱前的姓名（"张三 zhangsan@xx.com"）
  const beforeEmail = t.match(/([\u4e00-\u9fa5·]{2,4})[ \t]*[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (beforeEmail && isNameToken(beforeEmail[1])) return beforeEmail[1];

  // 5. 简历开头几行的独立姓名行（姓名常独占首行或第二行）
  //    遍历前 10 行（而非 5 行），过滤标题/标签/含数字的行，
  //    且该行不能是常见章节词（如"教育经历"）。
  const headLines = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 10);
  for (const line of headLines) {
    // 跳过含标题词/标签词的行
    if (/(简历|求职|应聘|姓名|名字|电话|手机|邮箱|学历|年龄|性别|学校|院校|公司|职位|岗位|民族|籍贯|住址|地址)/.test(line)) continue;
    // 含数字的行基本不是姓名行（日期/年限/电话），直接放弃
    if (/\d/.test(line)) continue;
    // 含英文的行通常是技能/项目描述（如"熟悉 React / Vue / TypeScript"），
    // 切段后会得到"熟悉"这类假姓名，整行放弃
    if (/[A-Za-z]/.test(line)) continue;
    // 整行就是姓名
    if (isNameToken(line)) return line;
    // 姓名常和职位/城市写在同一行："刘鹏 - 前端工程师"、"刘鹏 | 广州"、"刘鹏  前端开发"
    // 整行不匹配时按分隔符切段，取第一段判断。
    const segs = line.split(/[\s\-—–|｜·]+/).map((s) => s.trim()).filter(Boolean);
    if (segs.length > 1 && isNameToken(segs[0])) return segs[0];
  }

  // 6. 最后兜底：全文首个紧跟"男/女"或"年龄/岁"的中文短词（宽松匹配，同行走）
  const fallback = t.match(/([\u4e00-\u9fa5·]{2,4})[ \t]*(?=男|女|\d{1,2}[ \t]*岁)/);
  if (fallback && isNameToken(fallback[1])) return fallback[1];

  return "";
}

// ---------------------------------------------------------------------------
// 手机号 / 邮箱
// ---------------------------------------------------------------------------

export function extractPhone(text: string): string {
  const t = normalizeText(text);
  // 前后不能是数字，避免从身份证/QQ号中误截 11 位
  const m = t.match(/(?<!\d)1[3-9][\d\s-]{8,11}\d(?!\d)/);
  if (!m) return "";
  const digits = m[0].replace(/\D/g, "");
  return /^1[3-9]\d{9}$/.test(digits) ? digits : "";
}

export function extractEmail(text: string): string {
  const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0].toLowerCase() : "";
}

// ---------------------------------------------------------------------------
// 年龄 / 出生日期 / 性别
// ---------------------------------------------------------------------------

export function extractAge(text: string): number | null {
  const t = normalizeText(text);
  // "年龄:28" / "28岁" / "28 周岁"
  const ageMatch = t.match(/年龄\s*[:：]?\s*(\d{1,2})/) ||
    t.match(/(\d{1,2})\s*(?:岁|周岁)/) ||
    t.match(/[（(]\s*(\d{1,2})\s*岁\s*[）)]/);
  if (ageMatch) {
    const age = parseInt(ageMatch[1], 10);
    if (age >= 16 && age <= 80) return age;
  }
  // 由出生年份推算
  const birth = extractBirthDate(text);
  if (birth) {
    const year = parseInt(birth.slice(0, 4), 10);
    const age = new Date().getFullYear() - year;
    if (age >= 16 && age <= 80) return age;
  }
  return null;
}

// 出生日期：支持 YYYY-MM-DD / YYYY/MM/DD / YYYY年MM月DD日 / YYYY年MM月
export function extractBirthDate(text: string): string {
  const t = normalizeText(text);
  // 标签式优先："出生日期:1990-05-12"
  const label = t.match(/(?:出生日期|出生年月|出生|生日)\s*[:：]?\s*(\d{4})[年/\-.](\d{1,2})[月/\-.]?(\d{1,2})?/);
  if (label) {
    const y = label[1];
    const mo = label[2].padStart(2, "0");
    const d = label[3] ? label[3].padStart(2, "0") : "01";
    if (parseInt(mo, 10) >= 1 && parseInt(mo, 10) <= 12 && parseInt(d, 10) >= 1 && parseInt(d, 10) <= 31) {
      return `${y}-${mo}-${d}`;
    }
  }
  // 无标签全文兜底："1990年5月12日" 或 "1990-05-12"
  const raw = t.match(/(?:19|20)\d{2}[年/\-.](\d{1,2})[月/\-.]?(\d{1,2})?/);
  if (raw) {
    const y = raw[0].slice(0, 4);
    const mo = raw[1].padStart(2, "0");
    const d = raw[2] ? raw[2].padStart(2, "0") : "01";
    if (parseInt(mo, 10) >= 1 && parseInt(mo, 10) <= 12) return `${y}-${mo}-${d}`;
  }
  return "";
}

export function extractGender(text: string): string {
  const t = normalizeText(text);
  const m = t.match(/(?:性别)\s*[:：]?\s*(男|女)/) || t.match(/[（(]\s*(男|女)\s*[）)]/);
  if (m) return m[1];
  // 姓名后的"男/女"（如"张三 男 28岁"）
  const g = t.match(/[\u4e00-\u9fa5·]{2,4}\s+(男|女)(?=[\s,，;；]|$)/m);
  return g ? g[1] : "";
}

// ---------------------------------------------------------------------------
// 职位
// ---------------------------------------------------------------------------

const TITLE_SUFFIXES = [
  "架构师", "工程师", "设计师", "分析师", "总监", "经理", "主管", "专员",
  "顾问", "负责人", "专家", "主任", "店长", "教师", "医生", "律师",
  "会计", "出纳", "运营", "编辑", "翻译", "助理", "实习生", "销售代表",
  "研究员", "项目经理", "产品经理", "算法工程师", "前端工程师", "后端工程师",
  "测试工程师", "运维工程师", "开发工程师", "数据工程师", "产品总监", "技术总监",
];

function cleanTitle(raw: string): string {
  let s = raw.split(/[\n\r，,；;、|｜/]/)[0].trim();
  s = s.replace(/^(?:全职|兼职|实习|期望|意向|求职|应聘|目标)[:：]?\s*/, "");
  s = s.replace(/[:：].*$/, "");
  // 截到职位后缀词结束
  for (const suf of TITLE_SUFFIXES) {
    const idx = s.indexOf(suf);
    if (idx > 0) {
      s = s.slice(0, idx + suf.length);
      break;
    }
  }
  // 去掉尾部的城市/年限/薪资等杂讯
  s = s.replace(/\s*[\d.]+\s*(?:年|岁|月|k|K|万)?\s*$/, "");
  s = s.replace(/\s*[（(][^）)]*[）)]\s*$/, "");
  if (s.length > 24) s = s.slice(0, 24);
  return s.trim();
}

export function extractTitle(text: string): string {
  const t = normalizeText(text);
  // 1. 标签式："期望职位/求职意向/现任职位/职位/岗位/职务:XXX"
  const label = t.match(/(?:期望职位|期望岗位|求职意向|意向岗位|意向职位|应聘职位|应聘岗位|现任职位|当前职位|目标职位|职位|岗位|职务)\s*[:：]\s*([^\n\r,，;；]{2,30})/);
  if (label) {
    const cleaned = cleanTitle(label[1]);
    if (cleaned.length >= 2) return cleaned;
  }
  // 2. 逐行扫描含职位后缀的短行
  const suffixRe = new RegExp(`([一-龥A-Za-z0-9·+]{2,18}?(?:${TITLE_SUFFIXES.join("|")}))`);
  for (const line of t.split("\n")) {
    const l = line.trim();
    if (l.length > 30) continue;
    // 排除公司名 / 学校名行
    if (/(?:公司|有限|集团|大学|学院|学校)/.test(l)) continue;
    const m = l.match(suffixRe);
    if (m) {
      const cleaned = cleanTitle(m[1]);
      if (cleaned.length >= 2) return cleaned;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// 公司
// ---------------------------------------------------------------------------

// 院校名不是公司名。
// 踩过的坑：教育经历行常写成"2013.8~2017.6\t华南师范大学"，这行既有时间、又含
// "学校/学院"（恰好在下面的公司特征词表里），且通常排在实习/工作行之前，
// 于是 current_company 被填成了学校名。这里显式排除。
const SCHOOL_LIKE_RE = /(大学|学院|学校|中学|小学|职业技术|高等专科|研究生院)/;

export function extractCompany(text: string): string {
  const t = normalizeText(text);
  // 1. 标签式："所在公司/公司名称/公司/任职公司:XXX"
  const label = t.match(/(?:所在公司|任职公司|公司名称|目前公司|当前公司|现公司|就职于|公司)\s*[:：]\s*([^\n\r,，;；]{2,40})/);
  if (label) {
    const s = label[1].trim();
    if (/(公司|集团|科技|网络|信息|软件|有限|银行|医院|研究院|中心|厂|部)/.test(s) || s.length >= 3) return s;
  }
  // 2. 时间+公司+职位 结构："2020.03-至今  阿里巴巴  高级Java工程师"
  //    时间行通常含年份/至今等，公司名是时间之后、职位之前的片段
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // 跳过明显非公司行
    if (/(教育|项目|技能|自我评价|求职意向|联系方式|工作经历|工作经验|个人|姓名|电话|邮箱)/.test(line)) continue;
    // 找含时间段的行
    const hasTime = /(?:19|20)\d{2}\s*[./\-年]/.test(line) || /至今|现在|在职|present|now/i.test(line);
    if (!hasTime) continue;
    // 拆分空格/竖线分隔的片段
    const parts = line.split(/[\s|｜、]+/).map((p) => p.trim()).filter((p) => p.length >= 2);
    // 过滤掉时间片段和职位片段，剩下的中间片段作为公司候选
    const candidates: string[] = [];
    for (const p of parts) {
      if (/^(?:19|20)\d{2}|至今|现在|在职|present|now/i.test(p)) continue;          // 时间
      if (/^\d{1,2}\s*(?:年|月|岁|经验)$/.test(p)) continue;                          // 年限
      if (TITLE_SUFFIXES.some((s) => p.includes(s))) continue;                         // 职位
      if (/^[\d.\-~至—月年]+$/.test(p)) continue;                                      // 纯时间数字
      if (SCHOOL_LIKE_RE.test(p)) continue;                                            // 院校（教育经历行）
      candidates.push(p);
    }
    for (const p of candidates) {
      // 优先含公司特征词
      if (/(公司|集团|科技|网络|信息|软件|有限|银行|医院|学校|研究院|中心|厂|部|所|局|院)/.test(p)) {
        return p.replace(/^[\d.\-年月~至—\s]+/, "");
      }
    }
    // 无特征词时，取第一个长度合理的纯中文片段（如"阿里巴巴"）
    for (const p of candidates) {
      if (/^[\u4e00-\u9fa5（）()]{2,20}$/.test(p) && !isPlaceName(p)) {
        return p;
      }
    }
  }
  // 3. 全文兜底：第一个"XX公司/XX集团/XX科技有限公司"
  const first = t.match(/[\u4e00-\u9fa5A-Za-z0-9（）()]{2,20}(?:有限公司|股份有限公司|集团|科技有限公司|信息技术有限公司|网络科技有限公司|公司)/);
  if (first) return first[0].trim();
  return "";
}

// ---------------------------------------------------------------------------
// 院校
// ---------------------------------------------------------------------------

export function extractSchool(text: string): string {
  const t = normalizeText(text);
  // 标签式优先
  const label = t.match(/(?:毕业院校|毕业学校|毕业大学|院校|学校|母校)\s*[:：]\s*([^\n\r,，;；]{2,30})/);
  if (label) {
    const s = label[1].trim();
    if (/大学|学院|学校|职业技术|专科|研究院/.test(s)) return s;
  }
  // 全文第一个"XX大学/XX学院"
  const first = t.match(/[\u4e00-\u9fa5]{2,20}(?:大学|学院|职业技术学院|高等专科学校)/);
  if (first) return first[0].trim();
  return "";
}

// ---------------------------------------------------------------------------
// 城市
// ---------------------------------------------------------------------------

export function extractCity(text: string): string {
  const t = normalizeText(text);
  // 标签式优先
  const label = t.match(/(?:现居|现居住|所在城市|居住城市|常驻|城市|base|Base)\s*[:：]?\s*([\u4e00-\u9fa5]{2,4})/);
  if (label) {
    const c = label[1].replace(/[市省县区]$/, "");
    if (CITIES.includes(c)) return c;
  }
  // 全文兜底：取第一个命中的城市词（排除出现在院校名里的）
  const school = extractSchool(text);
  for (const c of CITIES) {
    if (!t.includes(c)) continue;
    // 如果该城市词是院校名的一部分（如"北京"在"北京大学"里），跳过继续找下一个
    if (school && school.includes(c) && school.length > c.length) continue;
    return c;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 技能
// ---------------------------------------------------------------------------

const SKILL_KEYWORDS = [
  "Java", "Spring", "Spring Boot", "SpringCloud", "Spring Cloud", "MyBatis",
  "MySQL", "Redis", "Kafka", "RabbitMQ", "RocketMQ", "Dubbo", "ZooKeeper",
  "微服务", "分布式", "Docker", "Kubernetes", "K8s", "Linux", "Python", "Go", "Golang",
  "React", "Vue", "Angular", "TypeScript", "JavaScript", "Node.js", "HTML", "CSS",
  "Flutter", "iOS", "Android", "Swift", "Kotlin", "C++", "C#", ".NET", "PHP", "Ruby",
  "Rust", "Scala", "机器学习", "深度学习", "AI", "NLP", "CV", "大数据", "Hadoop",
  "Spark", "Flink", "Hive", "HBase", "SQL", "Oracle", "PostgreSQL", "MongoDB",
  "Elasticsearch", "ES", "Nginx", "Tomcat", "Git", "Jenkins", "CI/CD", "DevOps",
  "AWS", "阿里云", "腾讯云", "项目管理", "数据分析", "自动化测试", "Selenium",
  "JMeter", "Figma", "Photoshop", "Excel", "PPT", "Word", "产品设计", "运营",
];

export function extractSkills(text: string): string {
  const t = normalizeText(text);
  const found = SKILL_KEYWORDS.filter((s) => t.includes(s));
  // 去重：大小写无关 + 避免 "Spring" 与 "Spring Boot" 重复
  const unique: string[] = [];
  for (const s of found) {
    const lower = s.toLowerCase();
    // 如果已有一个更长的关键词包含当前词（如已含"Spring Boot"则跳过"Spring"）
    if (unique.some((u) => u.toLowerCase().includes(lower) && u.length > s.length)) continue;
    if (unique.some((u) => u.toLowerCase() === lower)) continue;
    unique.push(s);
  }
  return unique.join(", ");
}

// ---------------------------------------------------------------------------
// 工作经验年限
// ---------------------------------------------------------------------------

export function extractYearsExperience(text: string): number | null {
  const t = normalizeText(text);
  const m = t.match(/(\d{1,2})\s*年(?:以上)?(?:工作经验|工作经历|经验|相关经验)/) ||
    t.match(/工作年限\s*[:：]?\s*(\d{1,2})/) ||
    t.match(/(\d{1,2})\s*年(?:以上)?(?:经验|从业)/);
  if (m) {
    const y = parseInt(m[1], 10);
    if (y >= 0 && y <= 60) return y;
  }
  return null;
}

// ---------------------------------------------------------------------------
// PDF 文本行聚合（支持双栏）
// ---------------------------------------------------------------------------

interface PdfItem {
  x: number;
  y: number;
  w: number;
  str: string;
}

// 把 pdfjs 的 textContent.items 按坐标还原成文本行。
// 双栏简历：左右两栏在相近 y 但 x 相差很远，按 x 聚类拆成两栏，避免字段串行。
export function extractPdfLines(content: any): string[] {
  const items: PdfItem[] = [];
  for (const it of content.items as any[]) {
    if (!("str" in it) || !it.str.trim()) continue;
    items.push({ x: it.transform[4], y: it.transform[5], w: it.width || 0, str: it.str });
  }
  if (items.length === 0) return [];

  // 页面宽度估算（取最大 x+w）
  const pageWidth = Math.max(...items.map((i) => i.x + i.w));
  // 双栏检测：右侧存在一定数量内容（x 超过页面中点）即视为双栏
  const leftItems = items.filter((i) => i.x < pageWidth * 0.5);
  const rightItems = items.filter((i) => i.x >= pageWidth * 0.5);
  const isTwoColumn = leftItems.length > 0 && rightItems.length > 0 && rightItems.length > items.length * 0.15;

  const buildLines = (its: PdfItem[]): string[] => {
    // 按 y 聚合（±3 视为同一行）
    const lineMap = new Map<number, PdfItem[]>();
    for (const it of its) {
      let key = Math.round(it.y);
      let found = false;
      for (const k of lineMap.keys()) {
        if (Math.abs(k - key) < 3) { key = k; found = true; break; }
      }
      void found;
      if (!lineMap.has(key)) lineMap.set(key, []);
      lineMap.get(key)!.push(it);
    }
    // PDF 坐标系 y 向上，按 y 从大到小 = 页面从上到下
    const sortedY = [...lineMap.keys()].sort((a, b) => b - a);
    return sortedY.map((y) => {
      const arr = lineMap.get(y)!.sort((a, b) => a.x - b.x);
      let s = "";
      let prevEnd = 0;
      for (const item of arr) {
        const gap = item.x - prevEnd;
        if (s && gap > 2) s += " ";
        s += item.str;
        prevEnd = item.x + item.w;
      }
      return s.trim();
    }).filter(Boolean);
  };

  if (isTwoColumn) {
    const leftLines = buildLines(leftItems);
    const rightLines = buildLines(rightItems);
    // 左栏（基本信息）在前，右栏（详细经历）在后
    return [...leftLines, ...rightLines];
  }
  return buildLines(items);
}
