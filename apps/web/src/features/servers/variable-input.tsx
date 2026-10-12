import { inputForRules } from "@/lib/variable-rules";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

/** Input chosen from an egg rule string: select for `in:`, switch for `boolean`, number, or text. */
export function VariableInput({
  id,
  rules,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
}: {
  id?: string;
  rules: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const kind = inputForRules(rules);
  if (kind.kind === "select") {
    const options = kind.options.map((o) => ({ value: o, label: o }));
    return (
      <Select
        id={id}
        value={value === "" ? undefined : value}
        onValueChange={onChange}
        options={options}
        placeholder={kind.optional ? "(none)" : "Choose…"}
        disabled={disabled}
        aria-invalid={invalid}
      />
    );
  }
  if (kind.kind === "boolean") {
    // Laravel's `boolean` rule accepts "0"/"1" as strings; legacy "true" displays as on.
    const on = value === "1" || value === "true";
    return (
      <Switch
        id={id}
        checked={on}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onCheckedChange={(c) => onChange(c ? "1" : "0")}
      />
    );
  }
  return (
    <Input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      inputMode={kind.kind === "number" ? (kind.integer ? "numeric" : "decimal") : undefined}
      maxLength={kind.kind === "text" ? kind.maxLength : undefined}
      spellCheck={false}
      className="font-mono"
    />
  );
}
