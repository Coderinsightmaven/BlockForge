import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";

/** Shown while a form has unsaved edits and the server value changed underneath them. */
export function ChangedElsewhere({ onDiscard }: { onDiscard: () => void }) {
  return (
    <Callout
      tone="warning"
      role="status"
      title="Changed elsewhere"
      action={
        <Button size="sm" variant="ghost" type="button" onClick={onDiscard}>
          Discard my changes
        </Button>
      }
    >
      This was changed (in another session or by someone else) while you were editing. Saving overwrites it
      with your values; discarding loads the current ones.
    </Callout>
  );
}
