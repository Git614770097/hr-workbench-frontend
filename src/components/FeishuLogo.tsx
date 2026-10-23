/**
 * 飞书品牌标识（简化矢量版）。
 *
 * 为什么不用现成的通用图标：顶栏原本用 MessageOutlined（一个通用消息气泡），
 * 用户看不出「这个按钮是飞书」。这里用飞书的品牌色块 + 双气泡造型，
 * 一眼能认出是飞书，而不是「某个消息功能」。
 *
 * 造型刻意固定为品牌蓝底 + 白色图形，不跟随主题色/文字色：
 * 品牌标识换了颜色就不是那个标识了。绑定状态改由外层
 * `.topbar-feishu-btn`（未绑定降透明度 + 红点）来表达。
 *
 * 如需替换成官方 SVG：保持 viewBox 24×24 与尺寸参数即可，调用方无需改动。
 */
export default function FeishuLogo({ size = 17 }: { size?: number }) {
  return (
    <svg
      className="feishu-logo"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      {/* 品牌底色：飞书蓝 */}
      <rect width="24" height="24" rx="6" fill="#3370FF" />
      {/* 后侧气泡（对方）：略淡，制造对话层次 */}
      <rect x="10.6" y="11.4" width="9.6" height="8.2" rx="2.4" fill="#FFFFFF" fillOpacity="0.88" />
      {/* 前侧气泡（自己）：带左下尾巴 */}
      <path
        fill="#FFFFFF"
        d="M6.2 5.4h7.3a2.4 2.4 0 0 1 2.4 2.4v3.3a2.4 2.4 0 0 1-2.4 2.4H9.6l-3.4 2.7v-2.7a2.4 2.4 0 0 1-2.4-2.4V7.8a2.4 2.4 0 0 1 2.4-2.4Z"
      />
    </svg>
  );
}
