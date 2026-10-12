import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { LoginRequest, MfaVerifyRequest, SetupRequest } from "@blockforge/contracts";
import type { Me } from "@blockforge/contracts";
import { authApi } from "@/lib/api/endpoints";
import { describeError, fieldErrorsFrom, isApiError } from "@/lib/api/errors";
import { sanitizeRedirect } from "@/lib/auth";
import { qk } from "@/lib/query-keys";
import { useLogout } from "@/components/shell/user-menu";
import { BrandMark } from "@/components/shell/sidebar";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

function AuthLayout({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <BrandMark className="mb-6 justify-center" />
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h1 className="text-base font-semibold">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </main>
  );
}

function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const d = describeError(error);
  return (
    <Callout tone="danger" role="alert" title={d.title}>
      {d.detail}
    </Callout>
  );
}

function zodErrors(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = String(i.path[0] ?? "form");
    out[k] ??= i.message;
  }
  return out;
}

function useCompleteSignIn() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async (me: Me, redirect: unknown) => {
    queryClient.setQueryData(qk.auth.me, me);
    queryClient.setQueryData(qk.auth.setup, { setupRequired: false });
    await navigate({ href: sanitizeRedirect(redirect), replace: true });
  };
}

export function LoginPage({ redirect }: { redirect?: string }) {
  const navigate = useNavigate();
  const complete = useCompleteSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = LoginRequest.safeParse({ email, password });
    if (!parsed.success) {
      setErrors(zodErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setError(null);
    setPending(true);
    try {
      const res = await authApi.login(parsed.data);
      if (res.status === "mfa_required") {
        await navigate({ to: "/mfa", search: { redirect: sanitizeRedirect(redirect) } });
      } else if (res.me) {
        await complete(res.me, redirect);
      } else {
        setError(new Error("The server accepted the sign-in but returned no session."));
      }
    } catch (err) {
      setError(err);
      setErrors(fieldErrorsFrom(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout title="Sign in" description="Use your BlockForge account.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError error={error} />
        <Field label="Email" error={errors.email}>
          <Input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
        </Field>
        <Field label="Password" error={errors.password}>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <Button type="submit" loading={pending} className="w-full">
          Sign in
        </Button>
        <p className="text-xs text-muted-foreground">
          Forgot your password? An administrator can reset it from Users &amp; Permissions.
        </p>
      </form>
    </AuthLayout>
  );
}

export function MfaPage({ redirect }: { redirect?: string }) {
  const complete = useCompleteSignIn();
  const navigate = useNavigate();
  const { logout, pending: loggingOut } = useLogout();
  const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = MfaVerifyRequest.safeParse({ code: code.replace(/\s+/g, "") });
    if (!parsed.success) {
      setFieldError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setFieldError(null);
    setError(null);
    setPending(true);
    try {
      const me = await authApi.verifyMfa(parsed.data);
      await complete(me, redirect);
    } catch (err) {
      if (isApiError(err) && err.code === "UNAUTHENTICATED") {
        await navigate({ to: "/login", search: { redirect: sanitizeRedirect(redirect) } });
        return;
      }
      setError(err);
      setCode("");
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout
      title="Two-factor authentication"
      description="Enter the 6-digit code from your authenticator app."
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError error={error} />
        <Field label="Authentication code" error={fieldError}>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
            autoFocus
            className="font-mono tracking-[0.3em]"
          />
        </Field>
        <Button type="submit" loading={pending} className="w-full">
          Verify
        </Button>
        <Button
          variant="link"
          className="self-center text-xs"
          loading={loggingOut}
          onClick={() => void logout()}
        >
          Sign in as someone else
        </Button>
      </form>
    </AuthLayout>
  );
}

export function SetupPage() {
  const complete = useCompleteSignIn();
  const [form, setForm] = useState({ setupToken: "", email: "", displayName: "", password: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { confirm, ...body } = form;
    const parsed = SetupRequest.safeParse({ ...body, setupToken: body.setupToken.trim() });
    const next = parsed.success ? {} : zodErrors(parsed.error.issues);
    if (confirm !== form.password) next.confirm = "Passwords do not match.";
    setErrors(next);
    if (!parsed.success || Object.keys(next).length) return;
    setError(null);
    setPending(true);
    try {
      const me = await authApi.setup(parsed.data);
      await complete(me, "/");
    } catch (err) {
      setError(err);
      setErrors(fieldErrorsFrom(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout
      title="Set up BlockForge"
      description="Create the owner account. The one-time setup token is printed to the control-plane log on first start."
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError error={error} />
        {isApiError(error) && error.code === "SETUP_ALREADY_COMPLETED" ? (
          <Link to="/login" search={{ redirect: undefined }} className="text-sm text-primary hover:underline">
            Go to sign in
          </Link>
        ) : null}
        <Field
          label="Setup token"
          error={errors.setupToken}
          hint="Copy it from the control-plane log output."
        >
          <Input
            value={form.setupToken}
            onChange={set("setupToken")}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            autoFocus
          />
        </Field>
        <Field label="Your name" error={errors.displayName}>
          <Input value={form.displayName} onChange={set("displayName")} autoComplete="name" maxLength={80} />
        </Field>
        <Field label="Email" error={errors.email}>
          <Input type="email" value={form.email} onChange={set("email")} autoComplete="username" />
        </Field>
        <Field
          label="Password"
          error={errors.password}
          hint="At least 12 characters. A long passphrase is best."
        >
          <Input
            type="password"
            value={form.password}
            onChange={set("password")}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Confirm password" error={errors.confirm}>
          <Input type="password" value={form.confirm} onChange={set("confirm")} autoComplete="new-password" />
        </Field>
        <Button type="submit" loading={pending} className="w-full">
          Create owner account
        </Button>
      </form>
    </AuthLayout>
  );
}
