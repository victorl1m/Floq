import { useState, type ComponentProps } from "react";
import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Keeps input semantics, refs, autofill and form associations on the real field. */
export function PasswordInput({ className, disabled, ...props }: Omit<ComponentProps<typeof Input>, "type">) {
  const [visible, setVisible] = useState(false);
  return <div className="relative w-full min-w-0">
    <Input {...props} disabled={disabled} type={visible ? "text" : "password"} className={cn("pr-10", className)} />
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={disabled}
      aria-label={visible ? "Hide password" : "Show password"}
      aria-pressed={visible}
      aria-controls={props.id}
      className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
      onClick={() => setVisible((value) => !value)}
    >
      {visible ? <IconEyeOff aria-hidden="true" /> : <IconEye aria-hidden="true" />}
    </Button>
  </div>;
}
