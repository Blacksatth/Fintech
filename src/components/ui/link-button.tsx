import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClassName, type ButtonSize, type ButtonVariant } from "./button";

export interface LinkButtonProps {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  "aria-label"?: string;
}

export function LinkButton({
  href,
  children,
  variant = "primary",
  size = "md",
  className,
  ...rest
}: LinkButtonProps) {
  return (
    <Link href={href} className={buttonClassName({ variant, size, className })} {...rest}>
      {children}
    </Link>
  );
}
