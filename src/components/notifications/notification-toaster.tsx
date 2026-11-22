import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { persists } from "@/lib/notifications";
import { useNotifications } from "./notifications-provider";
import { useNotificationAction } from "./use-notification-action";

/**
 * Headless: one transient toast per NEW notification, in the shared toast look (level icon and color come from the
 * shared Toaster). info and success go after ~5s; warning and error stay until dismissed. Notifications present on the
 * first load are never toasted, and each id is announced once. Reduced motion is handled by the shared Toaster styles.
 */
export function NotificationToaster({ suppressed = false }: { suppressed?: boolean } = {}) {
  const { items, loaded, markRead } = useNotifications();
  const run = useNotificationAction();
  const runRef = useRef(run);
  runRef.current = run;
  const markRef = useRef(markRead);
  markRef.current = markRead;
  const seen = useRef<Set<string> | null>(null);
  /** The island shows notify messages when it is available; the toast is only the fallback (web build, island off or failed). */
  const suppressedRef = useRef(suppressed);
  suppressedRef.current = suppressed;

  useEffect(() => {
    if (!loaded) return;
    if (seen.current === null) { seen.current = new Set(items.map((n) => n.id)); return; }
    for (const n of items) {
      if (seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      if (n.readAt || suppressedRef.current) continue;
      const show = toast[n.level];
      show(n.title, {
        id: `notification-${n.id}`,
        description: n.body ?? undefined,
        duration: persists(n.level) ? Infinity : 5000,
        action: n.action || n.plugin?.target ? { label: n.action?.label ?? "Open", onClick: () => { runRef.current(n); markRef.current([n.id]); } } : undefined,
      });
    }
  }, [items, loaded]);

  return null;
}
