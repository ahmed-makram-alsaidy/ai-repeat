import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Contains render crashes to the page that caused them — a broken page must
 * never blank the whole app again (lesson from the proxy bug: the crash in
 * Home left a fully white window with no recovery path).
 */
interface Props {
  children: ReactNode;
  /** Shown as the contained page's title in the fallback. */
  pageName: string;
  /** Navigates the user back to a working page. */
  onRecover: () => void;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[AI Repeat] page crash in ${this.props.pageName}:`, error.message, info.componentStack?.slice(0, 400));
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div>
          <h1>{this.props.pageName}</h1>
          <div className="notice bad">
            الصفحة دي وقعت بخطأ غير متوقع — **باقي التطبيق شغّال**. الخطأ:
            <code>{this.state.error.message.slice(0, 200)}</code>
          </div>
          <button className="primary" onClick={() => this.setState({ error: null })}>
            حاول تاني
          </button>{" "}
          <button className="ghost" onClick={this.props.onRecover}>
            ارجع للرئيسية
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
