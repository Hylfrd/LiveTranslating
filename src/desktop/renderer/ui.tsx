import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly size?: "small" | "regular";
}

export function IconButton({
  label,
  icon: Icon,
  size = "regular",
  className = "",
  ...props
}: IconButtonProps) {
  return (
    <button
      className={`icon-button icon-button--${size} ${className}`.trim()}
      type="button"
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon aria-hidden="true" strokeWidth={1.8} />
    </button>
  );
}

interface ToggleProps {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: () => void;
}

export function Toggle({ checked, disabled = false, label, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      className="toggle"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onChange}
    >
      <span className="toggle__thumb" aria-hidden="true" />
    </button>
  );
}

export function PaneTitle({
  children,
  action,
  id,
}: {
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly id?: string;
}) {
  return (
    <div className="pane-title">
      <h2 {...(id ? { id } : {})}>{children}</h2>
      {action}
    </div>
  );
}
