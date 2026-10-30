import { FormField } from "@shared/components/form-field"
import { Input } from "@shared/components/ui/input"
import { Checkbox } from "@shared/components/ui/checkbox"
import { Label } from "@shared/components/ui/label"
import { Switch } from "@shared/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@shared/components/ui/select"
import { fieldInputType, type ConfigDraft } from "./config-schema"
import type { JSONSchema, SchemaField } from "./types"

type Props = {
  schema: JSONSchema
  draft: ConfigDraft
  errors: Record<string, string>
  disabled: boolean
  update: (key: string, value: ConfigDraft[string] | undefined) => void
}
function ConfigField({
  fieldKey,
  field,
  index,
  schema,
  draft,
  errors,
  disabled,
  update,
}: Props & {
  fieldKey: string
  field: SchemaField
  index: number
}) {
  const key = fieldKey,
    id = `pluginConfigField-${index}`,
    value = draft[key]
  const required = schema.required?.includes(key)
  if (field.type === "array") {
    const selected = Array.isArray(value) ? value : []
    const range =
      field.minItems !== undefined && field.maxItems !== undefined
        ? field.minItems === field.maxItems
          ? `请选择 ${field.minItems} 项。`
          : `请选择 ${field.minItems}–${field.maxItems} 项。`
        : field.minItems !== undefined
          ? `至少选择 ${field.minItems} 项。`
          : field.maxItems !== undefined
            ? `最多选择 ${field.maxItems} 项。`
            : ""
    const help = [field.description, range].filter(Boolean).join(" ")
    return (
      <fieldset
        className="plugin-config-multiselect"
        disabled={disabled}
        data-invalid={!!errors[key] || undefined}
        aria-describedby={
          [help && `${id}-help`, errors[key] && `${id}-error`].filter(Boolean).join(" ") ||
          undefined
        }
      >
        <legend>
          {field.title || key}
          {required && (
            <>
              <span aria-hidden="true"> *</span>
              <span className="sr-only">（必填）</span>
            </>
          )}
        </legend>
        {help && (
          <p id={`${id}-help`} className="text-caption text-muted-foreground">
            {help}
          </p>
        )}
        <div className="plugin-config-options">
          {field.items!.enum.map((option, optionIndex) => (
            <Label
              className="plugin-config-option"
              key={optionIndex}
              htmlFor={`${id}-${optionIndex}`}
            >
              <Checkbox
                id={`${id}-${optionIndex}`}
                checked={selected.includes(option)}
                disabled={disabled}
                aria-invalid={!!errors[key]}
                onCheckedChange={(checked) =>
                  update(
                    key,
                    checked === true
                      ? [...new Set([...selected, option])]
                      : selected.filter((item) => item !== option),
                  )
                }
              />
              {option || "（空值）"}
            </Label>
          ))}
        </div>
        {errors[key] && (
          <p id={`${id}-error`} role="alert" className="form-error">
            {errors[key]}
          </p>
        )}
      </fieldset>
    )
  }
  return (
    <FormField
      id={id}
      label={field.title || key}
      help={field.description}
      required={required}
      error={errors[key]}
    >
      {field.enum ? (
        <Select
          value={
            value === undefined
              ? "unset"
              : String(Array.isArray(value) ? -1 : field.enum.indexOf(value))
          }
          disabled={disabled}
          onValueChange={(selected) =>
            update(key, selected === "unset" ? undefined : field.enum![Number(selected)])
          }
        >
          <SelectTrigger
            id={id}
            aria-invalid={!!errors[key]}
            aria-describedby={
              [field.description && `${id}-help`, errors[key] && `${id}-error`]
                .filter(Boolean)
                .join(" ") || undefined
            }
          >
            <SelectValue placeholder="请选择" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="unset">请选择</SelectItem>
              {field.enum.map((option, i) => (
                <SelectItem key={i} value={String(i)}>
                  {typeof option === "boolean"
                    ? option
                      ? "是"
                      : "否"
                    : String(option) || "（空值）"}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : field.type === "boolean" ? (
        <Switch
          id={id}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => update(key, checked)}
        />
      ) : (
        <Input
          id={id}
          type={fieldInputType(field)}
          value={value === undefined ? "" : String(value)}
          min={field.minimum}
          max={field.maximum}
          step={field.type === "integer" ? 1 : field.type === "number" ? "any" : undefined}
          required={required}
          autoComplete="off"
          placeholder={
            field.format === "date-time"
              ? "2026-10-30T09:00:00+08:00"
              : field.format === "timezone"
                ? "Asia/Shanghai"
                : undefined
          }
          onChange={(event) => update(key, event.target.value)}
        />
      )}
    </FormField>
  )
}

export function ConfigFields(props: Props) {
  const groups = new Map<string, { key: string; field: SchemaField; index: number }[]>()
  Object.entries(props.schema.properties || {}).forEach(([key, field], index) => {
    const group = field.group?.trim() || ""
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push({ key, field, index })
  })
  return (
    <>
      {[...groups.entries()].map(([group, fields]) => {
        const content = fields.map(({ key, field, index }) => (
          <ConfigField key={key} {...props} fieldKey={key} field={field} index={index} />
        ))
        return group ? (
          <fieldset className="plugin-config-group" key={group} disabled={props.disabled}>
            <legend>{group}</legend>
            {content}
          </fieldset>
        ) : (
          <div className="plugin-config-ungrouped" key={group}>
            {content}
          </div>
        )
      })}
    </>
  )
}
