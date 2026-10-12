import { useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

/* Small dialogs of the file manager (name/path/mode input, archive format): their own chunk. */

export function NameDialog({
  title,
  label,
  initial,
  hint,
  validate,
  onSubmit,
  onClose,
  pending,
}: {
  title: string;
  label: string;
  initial: string;
  hint?: string;
  validate: (v: string) => string | null;
  onSubmit: (v: string) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = validate(value);
    setError(err);
    if (!err) onSubmit(value.trim());
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <Field label={label} error={error} hint={hint}>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              {title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CompressDialog({
  count,
  pending,
  onClose,
  onSubmit,
}: {
  count: number;
  pending: boolean;
  onClose: () => void;
  onSubmit: (format: "tar.gz" | "zip") => void;
}) {
  const [format, setFormat] = useState<"tar.gz" | "zip">("tar.gz");
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Compress {count} item(s)</DialogTitle>
          <DialogDescription>The archive is created in the current folder.</DialogDescription>
        </DialogHeader>
        <Field label="Format">
          <Select
            value={format}
            onValueChange={setFormat}
            options={[
              { value: "tar.gz", label: "tar.gz (keeps permissions)" },
              { value: "zip", label: "zip (opens everywhere)" },
            ]}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(format)} loading={pending}>
            Compress
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
