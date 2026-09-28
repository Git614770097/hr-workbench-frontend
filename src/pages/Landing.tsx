import { useEffect, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import "../styles/landing.css";

/* 招聘漏斗演示数据（首屏可视化，等宽数字） */
const FUNNEL = [
  { name: "简历投递", count: "128", rate: "—", color: "#1d4ed8", points: "130,20 330,20 310,74 150,74", y: 47 },
  { name: "初筛通过", count: "52", rate: "40.6%", color: "#2b5fe0", points: "150,80 310,80 293,134 167,134", y: 107 },
  { name: "面试邀约", count: "21", rate: "40.4%", color: "#3f72ea", points: "167,140 293,140 279,194 181,194", y: 167 },
  { name: "发放 Offer", count: "7", rate: "33.3%", color: "#5b88f0", points: "181,200 279,200 267,254 193,254", y: 227 },
  { name: "成功入职", count: "5", rate: "71.4%", color: "#7fa3f5", points: "193,260 267,260 258,314 202,314", y: 287 },
];

const FEATURES = [
  {
    title: "人才库管理", desc: "简历拖拽导入、AI 智能解析，候选人信息统一建档、一屏检索。",
    tags: ["简历导入", "AI 解析"], c1: "#2563eb", c2: "#60a5fa",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 19.5c.7-3 2.8-4.6 5.5-4.6s4.8 1.6 5.5 4.6" />
        <path d="M16 7.2a3 3 0 0 1 0 5.6" />
        <path d="M17.4 15.2c1.8.6 3 2 3.3 4.1" />
      </svg>
    ),
  },
  {
    title: "招聘流程看板", desc: "拖拽式 Pipeline，从投递到入职，每个候选人停在哪个环节一目了然。",
    tags: ["看板", "拖拽流转"], c1: "#0891b2", c2: "#22d3ee",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.5" y="4" width="4.6" height="16" rx="1.4" />
        <rect x="9.7" y="4" width="4.6" height="10.5" rx="1.4" />
        <rect x="15.9" y="4" width="4.6" height="13" rx="1.4" />
      </svg>
    ),
  },
  {
    title: "招聘漏斗分析", desc: "转化率、耗时周期、流失点自动定位，招聘效率用数据说话。",
    tags: ["漏斗", "转化率"], c1: "#6366f1", c2: "#a78bfa",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 5.5h17L14.8 12v5.2l-5.6 2.3V12L3.5 5.5Z" />
      </svg>
    ),
  },
  {
    title: "合同管理", desc: "合同与试用期到期自动提醒，AI 识别合同日期，不漏一个关键节点。",
    tags: ["到期提醒", "合同归档"], c1: "#059669", c2: "#34d399",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7.5 3.5" />
        <path d="M14 3.5V8h4.5" />
        <path d="M9 12.5h6M9 16h6" />
      </svg>
    ),
  },
  {
    title: "社保 · 公积金 · 个税", desc: "增减员待办自动生成，个税累计预扣一键算清，薪资到手明明白白。",
    tags: ["增减员", "个税计算"], c1: "#d97706", c2: "#fbbf24",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="3.5" width="14" height="17" rx="2" />
        <path d="M8.5 7.5h7" />
        <path d="M12 10.5v7" />
        <path d="M9.7 12.6l4.6 3M14.3 12.6l-4.6 3" />
      </svg>
    ),
  },
  {
    title: "AI 招聘助手", desc: "一键生成岗位 JD 与人才画像，候选人匹配评分，招人更快更准。",
    tags: ["AI 生成", "智能匹配"], c1: "#7c3aed", c2: "#c084fc",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3.5l1.7 4.3L18 9.5l-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7L12 3.5Z" />
        <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" />
      </svg>
    ),
  },
];

const FLOW = [
  { title: "发布岗位", desc: "AI 辅助生成 JD" },
  { title: "收集简历", desc: "一键导入并解析" },
  { title: "推进流程", desc: "看板拖拽流转" },
  { title: "发放 Offer", desc: "合同归档提醒" },
  { title: "入职参保", desc: "社保增员待办" },
  { title: "离职减员", desc: "数据留存合规" },
];

const SECURITY = [
  { idx: "01", title: "租户隔离", desc: "每家企业数据按账号完全隔离，互不可见、互不干扰。" },
  { idx: "02", title: "权限分级", desc: "角色 + 菜单级权限控制，敏感操作可审计、可追溯。" },
  { idx: "03", title: "隐私合规", desc: "简历等个人信息处理遵循《个人信息保护法》，加密存储。" },
];

// 定价说明（2026-09-28 调整）：软件本身不赚钱，只作获客入口；
// 真实收益来自「按你的流程改造系统」的定制开发，所以不做功能分级——
// 试用和付费用户看到的功能完全一样，避免把潜在定制客户挡在门外。
const PLANS = [
  {
    name: "免费试用", kind: "plan",
    symbol: "¥", price: "0", period: "首个 30 天",
    desc: "先用起来，不合适就不用",
    feats: ["全部功能开放", "不限在招岗位", "简历导入与解析", "AI 生成 JD 与画像"],
    featured: false,
    cta: "开始试用",
  },
  {
    name: "早期用户专享", kind: "plan",
    symbol: "¥", price: "9.9", period: "首年 · 之后 ¥99 / 年",
    desc: "不分版本，所有功能都在里面",
    feats: ["全部招聘模块", "合同与社保台账", "待办与到期提醒", "招聘漏斗分析", "不限在招岗位"],
    featured: true,
    cta: "立即开通",
  },
  {
    name: "定制开发", kind: "custom",
    symbol: "", price: "按需报价", period: "按需求评估工时",
    desc: "按你公司的流程改造系统",
    feats: ["流程与字段调整", "对接内部系统", "专项报表开发", "可私有化部署"],
    featured: false,
    cta: "聊聊需求",
  },
];

// 定制开发能做什么（这是主要收益来源，单独用一个板块讲清楚）
const CUSTOM_ITEMS = [
  { idx: "01", title: "流程改造", desc: "你的招聘流程怎么走，系统就怎么改：增加环节、调整阶段、改审批方式。" },
  { idx: "02", title: "字段与报表", desc: "加你需要的字段、做你想要的统计口径，导出成你要的表格格式。" },
  { idx: "03", title: "系统对接", desc: "与现有 OA、考勤、财务或企业微信打通，避免数据两边录。" },
  { idx: "04", title: "私有化部署", desc: "部署到你自己的服务器或云账号，数据完全不出公司，独立维护。" },
];

// TODO：把下面换成你真实的联系方式（邮箱或微信号），页面会自动显示联系入口。
// 留空时定制板块只引导用户注册，不会显示占位式的假信息。
const CONTACT = { email: "", wechat: "" };

export default function Landing() {
  // 滚动 reveal：进入视口后加 .in 触发淡入上浮
  useEffect(() => {
    const els = document.querySelectorAll(".land-reveal");
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="land">
      {/* 顶部导航 */}
      <header className="land-nav">
        <div className="land-nav-inner">
          <Link to="/" className="land-logo">
            <span className="land-logo-mark">HR</span>
            <span>HR 工作台</span>
            <span className="land-logo-sub land-nav-sub">招聘全生命周期管理</span>
          </Link>
          <div className="land-nav-actions">
            <Link to="/login" className="land-nav-link">登录</Link>
            <Link to="/login" className="land-btn land-btn-primary land-btn-sm">免费试用</Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="land-hero">
          <div className="land-wrap land-hero-grid">
            <div>
              <span className="land-eyebrow land-hero-anim">
                <span className="land-eyebrow-dot" />招聘 · 人事 · 薪酬，一个工作台
              </span>
              <h1 className="land-hero-anim">
                一个人，也能顶<br />一整个 <span className="land-hl">HR 部门</span>
              </h1>
              <p className="land-hero-lead land-hero-anim">
                从发布岗位、收简历、推进流程，到合同归档、社保参保、个税计算——招聘的全生命周期，一个系统全部搞定。不再用 Excel 东拼西凑，不再漏掉任何一个到期日。
              </p>
              <div className="land-hero-cta land-hero-anim">
                <Link to="/login" className="land-btn land-btn-primary">免费试用 30 天</Link>
                <a href="#features" className="land-btn land-btn-ghost-hero">查看功能</a>
              </div>
              <div className="land-hero-kpis land-hero-anim">
                <div className="land-hero-kpi"><b className="num">6+</b><span>核心模块</span></div>
                <div className="land-hero-kpi"><b className="num">110+</b><span>人事模板</span></div>
                <div className="land-hero-kpi"><b className="num">0</b><span>部署成本</span></div>
              </div>
              <p className="land-hero-note land-hero-anim">
                注册后 <span className="num">30</span> 天全功能免费试用，不需要任何支付信息；之后早期用户首年 9.9 元。
              </p>
            </div>

            {/* 漏斗可视化 */}
            <div className="land-hero-visual">
              <div className="land-hero-visual-head">
                <span className="land-hero-visual-title">招聘转化漏斗</span>
                <span className="land-hero-visual-tag">LIVE DEMO</span>
              </div>
              <svg className="land-funnel" viewBox="0 0 460 340" role="img" aria-label="招聘转化漏斗示意图">
                {FUNNEL.map((f, i) => (
                  <polygon
                    key={f.name}
                    className="f-layer"
                    points={f.points}
                    fill={f.color}
                    style={{ animationDelay: `${420 + i * 80}ms` }}
                  />
                ))}
                {FUNNEL.map((f, i) => (
                  <g key={`t-${f.name}`} className="f-label" style={{ animationDelay: `${440 + i * 80}ms` }}>
                    <text x="124" y={f.y + 4} textAnchor="end" fill="#64748b" fontSize="13">{f.name}</text>
                    <text x="336" y={f.y - 1} textAnchor="start" fill="#0f172a" fontSize="16" fontWeight="700" fontFamily="JetBrains Mono, SF Mono, Consolas, monospace">{f.count}</text>
                    <text x="336" y={f.y + 17} textAnchor="start" fill="#2563eb" fontSize="12" fontFamily="JetBrains Mono, SF Mono, Consolas, monospace">{f.rate}</text>
                  </g>
                ))}
              </svg>
            </div>
          </div>
        </section>

        {/* 功能矩阵 */}
        <section className="land-section" id="features">
          <div className="land-wrap">
            <div className="land-section-head land-reveal">
              <span className="land-section-kicker">核心能力</span>
              <h2 className="land-section-title">覆盖招聘全链路的六大模块</h2>
              <p className="land-section-desc">
                不是一个"简历表格"，而是一套把招人这件事从"凭感觉"变成"有数据"的完整工作台。
              </p>
            </div>
            <div className="land-features-grid">
              {FEATURES.map((f, i) => (
                <div
                  className="land-feature land-reveal"
                  key={f.title}
                  style={{ "--feat-c1": f.c1, "--feat-c2": f.c2, "--feat-i": i } as CSSProperties}
                >
                  <span className="land-feature-glow" aria-hidden="true" />
                  <div className="land-feature-icon" aria-hidden="true">{f.icon}</div>
                  <span className="land-feature-idx">{String(i + 1).padStart(2, "0")}</span>
                  <h3>{f.title}</h3>
                  <p>{f.desc}</p>
                  <div className="land-feature-tags">
                    {f.tags.map((t) => <span className="land-feature-tag" key={t}>{t}</span>)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 招聘全生命周期 */}
        <section className="land-section land-flow">
          <div className="land-wrap">
            <div className="land-section-head land-reveal">
              <span className="land-section-kicker">工作流</span>
              <h2 className="land-section-title">从招人到离职，一条线走到底</h2>
              <p className="land-section-desc">
                招聘不是割裂的动作，而是一条连续的生命周期。每一步都有对应的模块兜底。
              </p>
            </div>
            <div className="land-flow-track">
              {FLOW.map((s, i) => (
                <div className="land-flow-step land-reveal" key={s.title}>
                  <span className="land-flow-dot" />
                  <span className="land-flow-num">STEP {String(i + 1).padStart(2, "0")}</span>
                  <h3>{s.title}</h3>
                  <p>{s.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 数据安全 */}
        <section className="land-section land-security">
          <div className="land-wrap">
            <div className="land-section-head land-reveal">
              <span className="land-section-kicker">数据安全</span>
              <h2 className="land-section-title">企业数据，交给你才安心</h2>
              <p className="land-section-desc">
                简历与人事信息是企业的核心资产，也是敏感个人信息。我们把安全与合规做在默认值里。
              </p>
            </div>
            <div className="land-security-grid">
              {SECURITY.map((s) => (
                <div className="land-security-item land-reveal" key={s.idx}>
                  <span className="num">{s.idx}</span>
                  <h3>{s.title}</h3>
                  <p>{s.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 定价 */}
        <section className="land-section" id="pricing">
          <div className="land-wrap">
            <div className="land-section-head land-reveal">
              <span className="land-section-kicker">定价</span>
              <h2 className="land-section-title">先用起来，再按你的需求改</h2>
              <p className="land-section-desc">
                软件本身定价很低，因为我们的主要服务是「按你公司的流程改造这套系统」。
                试用和付费用户看到的功能完全一样，不做版本分级。
              </p>
            </div>
            <div className="land-pricing-grid">
              {PLANS.map((p) => (
                <div className={`land-plan${p.featured ? " is-featured" : ""} land-reveal`} key={p.name}>
                  {p.featured && <span className="land-plan-badge">早期用户</span>}
                  <div className="land-plan-name">{p.name}</div>
                  <div className="land-plan-price">
                    <span className="num">{p.symbol}{p.price}</span>
                    <em>{p.period}</em>
                  </div>
                  <div className="land-plan-desc">{p.desc}</div>
                  <ul className="land-plan-feats">
                    {p.feats.map((f) => <li key={f}>{f}</li>)}
                  </ul>
                  {p.kind === "custom" ? (
                    CONTACT.email ? (
                      <a
                        href={`mailto:${CONTACT.email}?subject=${encodeURIComponent("定制开发咨询")}`}
                        className={`land-btn ${p.featured ? "land-btn-primary" : "land-btn-ghost"}`}
                      >
                        {p.cta}
                      </a>
                    ) : (
                      <Link to="/login" className={`land-btn ${p.featured ? "land-btn-primary" : "land-btn-ghost"}`}>
                        {p.cta}
                      </Link>
                    )
                  ) : (
                    <Link to="/login" className={`land-btn ${p.featured ? "land-btn-primary" : "land-btn-ghost"}`}>
                      {p.cta}
                    </Link>
                  )}
                </div>
              ))}
            </div>
            <p className="land-plan-footnote">
              试用期内不收费、不绑定支付方式；早期用户首年 9.9 元，之后每年 99 元。定制开发按需求单独评估报价。
            </p>
          </div>
        </section>

        {/* 定制开发：主要收益来源，单独一屏讲清楚 */}
        <section className="land-section land-security" id="custom">
          <div className="land-wrap">
            <div className="land-section-head land-reveal">
              <span className="land-section-kicker">定制开发</span>
              <h2 className="land-section-title">标准功能不够用？按你的流程改</h2>
              <p className="land-section-desc">
                每家公司的招聘流程都不一样，工具应该适配人，而不是反过来。
                主干功能已经跑通，要调整的地方我们直接改——比从零开发省时省钱。
              </p>
            </div>
            <div className="land-security-grid">
              {CUSTOM_ITEMS.map((s) => (
                <div className="land-security-item land-reveal" key={s.idx}>
                  <span className="num">{s.idx}</span>
                  <h3>{s.title}</h3>
                  <p>{s.desc}</p>
                </div>
              ))}
            </div>
            <div style={{ marginTop: "1.8rem", display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
              {CONTACT.email ? (
                <a
                  href={`mailto:${CONTACT.email}?subject=${encodeURIComponent("定制开发咨询")}`}
                  className="land-btn land-btn-primary"
                >
                  发送需求到邮箱
                </a>
              ) : null}
              {CONTACT.wechat ? (
                <p style={{ margin: 0, color: "var(--land-muted)", fontSize: "0.95rem" }}>
                  或添加微信：<b>{CONTACT.wechat}</b>
                </p>
              ) : null}
              {!CONTACT.email && !CONTACT.wechat ? (
                <>
                  <Link to="/login" className="land-btn land-btn-primary">注册后提需求</Link>
                  <p style={{ margin: 0, color: "var(--land-muted)", fontSize: "0.95rem" }}>
                    先免费用起来，真正的痛点往往在用起来之后才出现——那时再告诉我们。
                  </p>
                </>
              ) : null}
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="land-footer">
        <div className="land-wrap">
          <div className="land-footer-grid">
            <div className="land-footer-brand">
              <Link to="/" className="land-logo">
                <span className="land-logo-mark">HR</span>
                <span>HR 工作台</span>
              </Link>
              <p>让中小企业用一个人、一份预算，拥有规范的人事与招聘管理能力。</p>
            </div>
            <div className="land-footer-links">
              <div className="land-footer-col">
                <h4>产品</h4>
                <a href="#features">功能矩阵</a>
                <a href="#pricing">定价方案</a>
                <a href="#custom">定制开发</a>
              </div>
              <div className="land-footer-col">
                <h4>合规</h4>
                <a href="#security">数据安全</a>
              </div>
            </div>
          </div>
          <div className="land-footer-legal">
            <span>© {new Date().getFullYear()} HR 工作台 · 招聘全生命周期管理系统</span>
            <span className="num">Powered by Cloudflare</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
