import { cloneElement, useId, type ReactElement } from "react"
import { Label } from "./ui/label"
import { cn } from "@shared/lib/utils"

type ControlProps = {
  id?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean | "true" | "false"
}
export type FormFieldProps = {
  id?: string
  label: string
  help?: string
  error?: string
  required?: boolean
  className?: string
  children: ReactElement<ControlProps>
}
export function FormField({
  id,
  label,
  help,
  error,
  required,
  className,
  children,
}: FormFieldProps) {
  const generatedId = useId()
  const fieldId = id || children.props.id || generatedId
  const description =
    [children.props["aria-describedby"], help && `${fieldId}-help`, error && `${fieldId}-error`]
      .filter(Boolean)
      .join(" ") || undefined
  return (
    <div
      data-invalid={error ? true : undefined}
      className={cn("ui-field flex min-w-0 flex-col gap-2", className)}
    >
      <Label id={fieldId + "-label"} htmlFor={fieldId}>
        {label}
        {required && (
          <span aria-hidden="true" className="text-destructive-ink">
            {" "}
            *
          </span>
        )}
        {required && <span className="sr-only">（必填）</span>}
      </Label>
      {cloneElement(children, {
        id: fieldId,
        "aria-describedby": description,
        "aria-invalid": error ? true : children.props["aria-invalid"],
      })}
      {help && (
        <p id={`${fieldId}-help`} className="text-caption text-muted-foreground">
          {help}
        </p>
      )}
      {error && (
        <p id={`${fieldId}-error`} role="alert" className="text-sm text-destructive-ink">
          {error}
        </p>
      )}
    </div>
  )
}
