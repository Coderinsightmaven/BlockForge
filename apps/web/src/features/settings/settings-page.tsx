import { useQueryClient } from "@tanstack/react-query";
import { Monitor, Moon, ShieldCheck, ShieldOff, Sun } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ChangePasswordRequest, TotpCode } from "@blockforge/contracts";
import type { Me } from "@blockforge/contracts";
import { authApi } from "@/lib/api/endpoints";
import { describeError, fieldErrorsFrom } from "@/lib/api/errors";
import { formatTimestamp } from "@/lib/format";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { useTheme } from "@/lib/theme";
import type { ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RoleBadges } from "@/features/users/user-dialogs";

export type SettingsTab = "account" | "security" | "appearance";

/** "JBSWY3DPEHPK3PXP" → "JBSW Y3DP EHPK 3PXP" for manual entry. */
export function groupSecret(secret: string): string {
  return secret
    .replace(/\s+/g, "")
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

function ChangePassword() {
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const change = useApiMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) => authApi.changePassword(body),
    success: "Password changed. Your other sessions were signed out.",
    errorTitle: "Could not change password",
    onSuccess: () => setForm({ currentPassword: "", newPassword: "", confirm: "" }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = ChangePasswordRequest.safeParse({
      currentPassword: form.currentPassword,
      newPassword: form.newPassword,
    });
    const next: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) next[String(i.path[0])] ??= i.message;
    if (form.newPassword !== form.confirm) next.confirm = "Passwords do not match.";
    if (form.newPassword && form.newPassword === form.currentPassword)
      next.newPassword = "Choose a password different from the current one.";
    setErrors(next);
    if (!parsed.success || Object.keys(next).length) return;
    change.mutate(parsed.data, { onError: (err) => setErrors(fieldErrorsFrom(err)) });
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Change password</CardTitle>
          <CardDescription>Other signed-in sessions are signed out after a change.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex max-w-sm flex-col gap-3" noValidate>
          {/* Lets password managers associate the change with the account. */}
          <input type="text" autoComplete="username" hidden readOnly />
          <Field label="Current password" error={errors.currentPassword}>
            <Input
              type="password"
              value={form.currentPassword}
              onChange={set("currentPassword")}
              autoComplete="current-password"
            />
          </Field>
          <Field
            label="New password"
            error={errors.newPassword}
            hint="At least 12 characters. A long passphrase is best."
          >
            <Input
              type="password"
              value={form.newPassword}
              onChange={set("newPassword")}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Confirm new password" error={errors.confirm}>
            <Input
              type="password"
              value={form.confirm}
              onChange={set("confirm")}
              autoComplete="new-password"
            />
          </Field>
          <Button type="submit" loading={change.isPending} className="self-start">
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** QR code drawn locally on a canvas — the TOTP secret never leaves the browser for rendering. */
function OtpQrCode({ value }: { value: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    QRCode.toCanvas(ref.current, value, {
      width: 184,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not render QR code"));
  }, [value]);
  if (error) return <Callout tone="danger">{error}. Use the manual key instead.</Callout>;
  return (
    <canvas
      ref={ref}
      className="rounded-md border bg-white"
      role="img"
      aria-label="QR code for your authenticator app"
    />
  );
}

function MfaSection({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const [enrollment, setEnrollment] = useState<{ otpauthUrl: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const refreshMe = () => queryClient.invalidateQueries({ queryKey: qk.auth.me });

  const start = useApiMutation({
    mutationFn: () => authApi.mfaEnrollStart(),
    errorTitle: "Could not start MFA enrolment",
    onSuccess: (r) => {
      setEnrollment(r);
      setCode("");
      setCodeError(null);
    },
  });
  const confirm = useApiMutation({
    mutationFn: (c: string) => authApi.mfaEnrollConfirm({ code: c }),
    success: "Two-factor authentication enabled",
    silentError: true,
    onSuccess: async () => {
      setEnrollment(null);
      setCode("");
      await refreshMe();
    },
  });
  const disable = useApiMutation({
    mutationFn: (c: string) => authApi.mfaDisable({ code: c }),
    success: "Two-factor authentication disabled",
    silentError: true,
    onSuccess: async () => {
      setCode("");
      await refreshMe();
    },
  });

  const validateCode = (): string | null => {
    const c = code.replace(/\s+/g, "");
    if (!TotpCode.safeParse(c).success) {
      setCodeError("Enter the 6-digit code from your authenticator app.");
      return null;
    }
    setCodeError(null);
    return c;
  };

  const codeField = (label: string, error: unknown) => (
    <Field label={label} error={codeError ?? (error ? describeError(error).title : null)}>
      <Input
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
        className="max-w-40 font-mono tracking-[0.3em]"
      />
    </Field>
  );

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            Two-factor authentication
            {me.user.mfaEnabled ? (
              <Badge tone="success">
                <ShieldCheck aria-hidden /> Enabled
              </Badge>
            ) : (
              <Badge tone="warning">
                <ShieldOff aria-hidden /> Off
              </Badge>
            )}
          </CardTitle>
          <CardDescription>Time-based one-time codes (TOTP) from an authenticator app.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {me.user.mfaEnabled ? (
          <form
            className="flex flex-col gap-3"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const c = validateCode();
              if (c) disable.mutate(c);
            }}
          >
            <p className="text-sm text-muted-foreground">
              To turn MFA off, confirm with a current code. Your account is then protected by its password
              alone.
            </p>
            {codeField("Current code", disable.error)}
            <Button type="submit" variant="destructive" loading={disable.isPending} className="self-start">
              Disable two-factor authentication
            </Button>
          </form>
        ) : !enrollment ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              Strongly recommended for every administrator account.
            </p>
            <Button loading={start.isPending} onClick={() => start.mutate()}>
              <ShieldCheck aria-hidden />
              Set up two-factor authentication
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const c = validateCode();
              if (c) confirm.mutate(c);
            }}
          >
            <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm">
              <li>
                Scan this QR code with your authenticator app.
                <div className="mt-2">
                  <OtpQrCode value={enrollment.otpauthUrl} />
                </div>
              </li>
              <li>
                Or enter this key manually:
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="rounded-md border bg-muted px-2 py-1 font-mono text-sm tracking-wider break-all">
                    {groupSecret(enrollment.secret)}
                  </code>
                  <CopyButton value={enrollment.secret} label="Copy key" />
                </div>
              </li>
              <li>Enter the 6-digit code the app shows to finish.</li>
            </ol>
            {codeField("Verification code", confirm.error)}
            <div className="flex gap-2">
              <Button type="submit" loading={confirm.isPending}>
                Enable
              </Button>
              <Button variant="outline" onClick={() => setEnrollment(null)} disabled={confirm.isPending}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function Appearance() {
  const { preference, setPreference, resolved } = useTheme();
  const options: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
    { value: "system", label: "System", icon: Monitor },
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
  ];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Theme</CardTitle>
          <CardDescription>
            Stored in this browser. “System” follows your operating system (currently {resolved}).
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div role="radiogroup" aria-label="Theme" className="flex flex-wrap gap-2">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={preference === o.value}
              onClick={() => setPreference(o.value)}
              className={cn(
                "flex w-28 flex-col items-center gap-1.5 rounded-md border p-3 text-sm hover:bg-accent",
                preference === o.value && "border-primary ring-1 ring-primary",
              )}
            >
              <o.icon className="size-5" aria-hidden />
              {o.label}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function SettingsPage({
  me,
  tab,
  onTabChange,
}: {
  me: Me;
  tab: SettingsTab;
  onTabChange: (t: SettingsTab) => void;
}) {
  return (
    <>
      <PageHeader title="Settings" description="Your account, security and display preferences." />
      <Tabs value={tab} onValueChange={(v) => onTabChange(v as SettingsTab)}>
        <TabsList>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
        </TabsList>
        <TabsContent value="account" className="flex flex-col gap-3">
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Name</dt>
                <dd>{me.user.displayName}</dd>
                <dt className="text-muted-foreground">Email</dt>
                <dd>{me.user.email}</dd>
                <dt className="text-muted-foreground">Roles</dt>
                <dd>
                  <RoleBadges roles={me.user.roles} />
                </dd>
                <dt className="text-muted-foreground">Session expires</dt>
                <dd>{formatTimestamp(me.session.expiresAt)}</dd>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                An administrator can change your name from Users &amp; Permissions.
              </p>
            </CardContent>
          </Card>
          <ChangePassword />
        </TabsContent>
        <TabsContent value="security">
          <MfaSection me={me} />
        </TabsContent>
        <TabsContent value="appearance">
          <Appearance />
        </TabsContent>
      </Tabs>
    </>
  );
}
