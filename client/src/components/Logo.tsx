import logoFull from "@/assets/logos/logo-full.png";
import logoIcon from "@/assets/logos/logo-icon.png";
import logoWhite from "@/assets/logos/logo-white.png";
import { cn } from "@/lib/utils";

export type LogoVariant = "full" | "icon" | "horizontal" | "white";
export type LogoSize = "sm" | "md" | "lg" | "xl";

const SOURCES: Record<LogoVariant, string> = {
  full: logoFull,
  // No separate horizontal lockup exists yet — falls back to the full logo.
  horizontal: logoFull,
  icon: logoIcon,
  white: logoWhite,
};

const HEIGHT_CLASSES: Record<LogoSize, string> = {
  sm: "h-8",
  md: "h-12",
  lg: "h-16",
  xl: "h-24",
};

export interface LogoProps {
  variant?: LogoVariant;
  size?: LogoSize;
  className?: string;
}

export function Logo({ variant = "full", size = "md", className }: LogoProps) {
  return (
    <img
      src={SOURCES[variant]}
      alt="NYC Home Rehab Physical Therapy Logo"
      className={cn("w-auto object-contain", HEIGHT_CLASSES[size], className)}
    />
  );
}

export default Logo;
