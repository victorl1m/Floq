import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface State {
    error: Error | null;
}

/** Catches render errors so one broken component does not white-screen the app. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("UI error", error, info.componentStack);
    }

    render() {
        if (!this.state.error) return this.props.children;
        return (
            <div className="fixed inset-x-0 top-[40px] bottom-(--app-footer-height) z-50 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
                <p className="text-sm font-medium">Something went wrong</p>
                <p className="max-w-md text-xs text-muted-foreground">{this.state.error.message}</p>
                <Button onClick={() => window.location.reload()}>Reload</Button>
            </div>
        );
    }
}
