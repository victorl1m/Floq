import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { IconCircleCheck, IconInfoCircle, IconAlertTriangle, IconAlertOctagon, IconLoader } from "@tabler/icons-react"

const toastClassNames = {
  toast: "cn-toast",
  title: "cn-toast-title",
  description: "cn-toast-description",
  content: "cn-toast-content",
  icon: "cn-toast-icon",
  closeButton: "cn-toast-close",
  actionButton: "cn-toast-action",
  cancelButton: "cn-toast-cancel",
  success: "cn-toast-success",
  info: "cn-toast-info",
  warning: "cn-toast-warning",
  error: "cn-toast-error",
  loading: "cn-toast-loading",
}

const Toaster = ({ toastOptions, ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      {...props}
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="top-right"
      offset={64}
      mobileOffset={{ top: 64, left: 12, right: 12 }}
      visibleToasts={3}
      gap={8}
      expand={false}
      closeButton
      icons={{
        success: <IconCircleCheck className="size-4" aria-hidden="true" />,
        info: <IconInfoCircle className="size-4" aria-hidden="true" />,
        warning: <IconAlertTriangle className="size-4" aria-hidden="true" />,
        error: <IconAlertOctagon className="size-4" aria-hidden="true" />,
        loading: <IconLoader className="size-4 animate-spin" aria-hidden="true" />,
        close: <span aria-hidden="true">×</span>,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        unstyled: true,
        closeButton: true,
        closeButtonAriaLabel: "Dismiss notification",
        classNames: {
          ...toastOptions?.classNames,
          ...toastClassNames,
        },
      }}
    />
  )
}

export { Toaster }
