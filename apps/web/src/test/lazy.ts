import { screen, waitFor } from "@testing-library/react";

/**
 * The open dialog once its lazy chunk has arrived: `LazyDialog` first shows a loading dialog (same
 * title, marked `data-lazy-dialog="loading"`), which is replaced by the real one.
 */
export async function findLoadedDialog(timeout = 5000): Promise<HTMLElement> {
  return waitFor(
    () => {
      const dialog = screen.getByRole("dialog");
      if (dialog.querySelector('[data-lazy-dialog="loading"]'))
        throw new Error("The dialog is still loading");
      return dialog;
    },
    { timeout },
  );
}
