import { cloneElement, useId, type ReactElement } from "react"
import { Label } from "./ui/label"
import { cn } from "@shared/lib/utils"

type ControlProps = { id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean | "true" | "false" }
export type FormFieldProps = { id?: string; label: string; help?: string; error?: string; required?: boolean; className?: string; children: ReactElement<ControlProps> }
export function FormField({ id, label, help, error, required, className, children }: FormFieldProps) {
  const generatedId = useId()
  const fieldId = id || children.props.id || generatedId
  const description = [children.props["aria-describedby"], help && `${fieldId}-help`, error && `${fieldId}-error`].filter(Boolean).join(" ") || undefined
  return <div className={cn("space-y-2", className)}><Label htmlFor={fieldId}>{label}{required && <span aria-hidden="true" className="text-destructive"> *</span>}{required && <span className="sr-only">（必填）</span>}</Label>{cloneElement(children, { id: fieldId, "aria-describedby": description, "aria-invalid": error ? true : children.props["aria-invalid"] })}{help && <p id={`${fieldId}-help`} className="text-xs leading-5 text-muted-foreground">{help}</p>}{error && <p id={`${fieldId}-error`} role="alert" className="text-xs leading-5 text-destructive">{error}</p>}</div>
}
