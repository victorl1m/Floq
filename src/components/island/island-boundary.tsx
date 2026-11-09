import { Component, type ReactNode } from 'react';
import { islandLog } from './island-log';

type Props = { children: ReactNode };
type State = { failed: boolean; epoch: number };

/** A render error would unmount the island tree and leave an empty transparent window: log it and remount. */
export default class IslandBoundary extends Component<Props, State> {
  state: State = { failed: false, epoch: 0 };
  private timer: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError(): Partial<State> { return { failed: true }; }

  componentDidCatch(error: unknown) {
    islandLog('render error: ' + String(error).slice(0, 200));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.setState(s => ({ failed: false, epoch: s.epoch + 1 })), 300);
  }

  componentWillUnmount() { clearTimeout(this.timer); }

  render() {
    if (this.state.failed) return null;
    return <div key={this.state.epoch} style={{ display: 'contents' }}>{this.props.children}</div>;
  }
}
