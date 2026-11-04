# View transitions

Floq uses the browser's same-document View Transitions API through `runViewTransition` in `src/lib/view-transition.ts`. This is a small Vite/React integration; it does not add Next.js or upgrade React. The API takes a snapshot, runs the supplied update once, and animates the named workspace content. Older or unsupported WebViews run the same update immediately.

Navigation transitions are limited to Home, Tasks, Skills, and Secrets. Changes involving Canvas, Terminal, or Session stay direct so a transition never snapshots terminal output or live session content. Rapid navigation skips the active transition before beginning the next one. The app's reduced-motion preference and the operating system preference both bypass animation.

The `workspace-view` class names the main content snapshot. CSS crossfades only that surface for 180 ms; the app shell stays in place. Keep this animation restrained and avoid applying the name to terminal panes or other continuously updating content.

## Platform notes

`document.startViewTransition()` is the native same-document API. It is feature-detected because older browsers and WebViews may not implement it. Tauri uses WebView2 on Windows, and system WebKit on macOS and Linux, so support depends on the installed runtime. The fallback preserves navigation behavior without animation.

Next.js documents React's declarative `<ViewTransition>` integration, but that route depends on newer React APIs and is not the implementation used here. This project currently uses React 19.1 and ordinary state-based navigation.

## References

- [MDN: Document.startViewTransition()](https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition)
- [Next.js: Designing view transitions](https://nextjs.org/docs/app/guides/view-transitions)
- [Tauri: Webview versions](https://v2.tauri.app/reference/webview-versions/)
