import type { ReactNode } from "react";

/** A label over its control, for the plain forms in Studio's dialogs. */
export function FormField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-step-10 text-text-3">
        {label}
      </label>
      {children}
    </div>
  );
}
