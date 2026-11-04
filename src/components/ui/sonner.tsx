import { useEffect } from "react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, useSonner, type ToasterProps } from "sonner"
import { IconCircleCheck, IconInfoCircle, IconAlertTriangle, IconAlertOctagon, IconLoader, IconX } from "@tabler/icons-react"

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
  // One notch, a queue behind it: the front toast shows "+N more" for the rest.
  const count = useSonner().toasts.length
  const pending = Math.max(0, count - 1)

  // Swipe polish on top of sonner's gesture: fade with drag distance, and Escape (with focus inside
  // the toasts) dismisses the front toast, where sonner's own Escape only collapses the stack.
  useEffect(() => {
    if (count === 0) return
    const list = document.querySelector<HTMLElement>("[data-sonner-toaster]")
    if (!list) return
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const el = record.target as HTMLElement
        if (!el.matches("[data-sonner-toast]")) continue
        const x = parseFloat(el.style.getPropertyValue("--swipe-amount-x")) || 0
        const y = parseFloat(el.style.getPropertyValue("--swipe-amount-y")) || 0
        const fade = (1 - Math.min(Math.hypot(x, y) / 160, 1) * 0.45).toFixed(3)
        if (el.style.getPropertyValue("--toast-drag-fade") !== fade) el.style.setProperty("--toast-drag-fade", fade)
      }
    })
    observer.observe(list, { attributes: true, attributeFilter: ["style"], subtree: true })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      const target = event.target as Element | null
      if (!target?.closest("[data-sonner-toaster]")) return
      const toast = target.closest<HTMLElement>("[data-sonner-toast]") ?? list.querySelector<HTMLElement>('[data-sonner-toast][data-front="true"]')
      toast?.querySelector<HTMLButtonElement>(".cn-toast-close")?.click()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      observer.disconnect()
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [count])

  return (
    <Sonner
      {...props}
      theme={theme as ToasterProps["theme"]}
      className={pending > 0 ? "toaster group" : "toaster toaster-solo group"}
      position="top-center"
      offset={52}
      mobileOffset={{ top: "calc(env(safe-area-inset-top) + 52px)", left: 12, right: 12 }}
      visibleToasts={3}
      gap={8}
      expand={false}
      swipeDirections={["top", "left", "right"]}
      closeButton
      icons={{
        success: <IconCircleCheck className="size-4" aria-hidden="true" />,
        info: <IconInfoCircle className="size-4" aria-hidden="true" />,
        warning: <IconAlertTriangle className="size-4" aria-hidden="true" />,
        error: <IconAlertOctagon className="size-4" aria-hidden="true" />,
        loading: <IconLoader className="size-4 animate-spin" aria-hidden="true" />,
        close: <IconX className="size-3.5" aria-hidden="true" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          "--toast-pending": pending,
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        unstyled: true,
        closeButton: true,
        duration: 5000,
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
