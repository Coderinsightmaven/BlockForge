import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import { useState } from "react";
import type { Me } from "@blockforge/contracts";
import { apiClient } from "@/lib/api/client";
import { clearConsoleHistories } from "@/lib/console-history";
import { authApi } from "@/lib/api/endpoints";
import { isApiError } from "@/lib/api/errors";
import { toastError } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { useTheme } from "@/lib/theme";
import type { ThemePreference } from "@/lib/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const chars =
    parts.length > 1 ? [parts[0]![0], parts[parts.length - 1]![0]] : [parts[0]?.[0], parts[0]?.[1]];
  return chars.filter(Boolean).join("").toUpperCase() || "?";
}

/** Ends the session server-side, then drops every cached query. */
export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const logout = async () => {
    setPending(true);
    try {
      await authApi.logout();
    } catch (err) {
      // An already-expired session is as good as logged out.
      if (!(isApiError(err) && err.code === "UNAUTHENTICATED")) {
        setPending(false);
        toastError(err, "Sign-out failed");
        return;
      }
    }
    apiClient.setCsrfToken(null);
    clearConsoleHistories();
    // Drop the session first so /login does not bounce back, then wipe everything once the
    // authenticated views have unmounted.
    queryClient.removeQueries({ queryKey: qk.auth.me });
    await navigate({ to: "/login", search: { redirect: undefined } });
    queryClient.clear();
    setPending(false);
  };
  return { logout, pending };
}

export function UserMenu({ me }: { me: Me }) {
  const { preference, setPreference } = useTheme();
  const navigate = useNavigate();
  const { logout, pending } = useLogout();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary/90"
          aria-label={`Account menu for ${me.user.displayName}`}
        >
          {initials(me.user.displayName)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex flex-col">
          <span className="truncate text-sm text-foreground">{me.user.displayName}</span>
          <span className="truncate font-normal">{me.user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate({ to: "/settings" })}>
          <Settings aria-hidden />
          Account settings
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {preference === "dark" ? (
              <Moon aria-hidden />
            ) : preference === "light" ? (
              <Sun aria-hidden />
            ) : (
              <Monitor aria-hidden />
            )}
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={preference}
              onValueChange={(v) => setPreference(v as ThemePreference)}
            >
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={pending} onSelect={() => void logout()}>
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
