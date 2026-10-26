import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "../utils/clientError";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 顶层错误边界：任何一个页面组件渲染崩溃时，不再整站白屏，
 * 而是显示「页面出错了」兜底卡（刷新 / 回待办日历），同时把错误上报留痕。
 *
 * 注意：本组件在首屏链路上（main.tsx 直接包住 App），
 * 一律不引 antd（桶文件会把首屏拖大），只用 global.css 里的 .error-boundary-fallback。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError(error, { componentStack: info.componentStack || "" });
  }

  private reset = () => {
    // 用户点「重试」时清掉错误重挂子树——部分瞬时错误（如 chunk 抖动）能自愈
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary-fallback">
        <div className="ebf-card">
          <div className="ebf-title">页面出错了</div>
          <div className="ebf-desc">
            系统遇到了一个未预期的问题，已自动记录。你可以刷新页面重试，或返回待办日历。
          </div>
          {error.message ? <div className="ebf-detail">{error.message}</div> : null}
          <div className="ebf-actions">
            <button type="button" className="ebf-btn ebf-btn-primary" onClick={() => location.reload()}>
              刷新页面
            </button>
            <button type="button" className="ebf-btn" onClick={this.reset}>
              重试
            </button>
            <button type="button" className="ebf-btn" onClick={() => (location.href = "/tasks")}>
              返回待办
            </button>
          </div>
        </div>
      </div>
    );
  }
}
