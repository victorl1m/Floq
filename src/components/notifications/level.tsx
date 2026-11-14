import { IconAlertOctagon, IconAlertTriangle, IconCircleCheck, IconInfoCircle } from "@tabler/icons-react";
import type { NotificationLevel } from "@/lib/notifications";

export const levelMeta: Record<NotificationLevel, { label: string; Icon: typeof IconInfoCircle; tone: string }> = {
  info: { label: "Info", Icon: IconInfoCircle, tone: "text-sky-600 dark:text-sky-400" },
  success: { label: "Success", Icon: IconCircleCheck, tone: "text-emerald-600 dark:text-emerald-400" },
  warning: { label: "Warning", Icon: IconAlertTriangle, tone: "text-amber-600 dark:text-amber-400" },
  error: { label: "Error", Icon: IconAlertOctagon, tone: "text-red-600 dark:text-red-400" },
};
