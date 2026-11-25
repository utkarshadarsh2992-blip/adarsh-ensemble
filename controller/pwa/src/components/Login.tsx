import { useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, Mail, ShieldCheck } from "lucide-react";
import { auth } from "../api";
import { Dialog } from "./ui";

type LoginMethod = "password" | "email";
const OTP_COOLDOWN_KEY = "adarsh-controller-otp-cooldown-until";
const OTP_RESEND_COOLDOWN_MS = 60_000;
const OTP_RATE_LIMIT_BACKOFF_MS = 60 * 60_000;

function readOtpCooldown(): number {
  try {
    const until = Number(window.sessionStorage.getItem(OTP_COOLDOWN_KEY));
    return Number.isFinite(until) ? until : 0;
  } catch {
    return 0;
  }
}

function saveOtpCooldown(until: number): void {
  try {
    window.sessionStorage.setItem(OTP_COOLDOWN_KEY, String(until));
  } catch {
    // The server remains authoritative if browser storage is unavailable.
  }
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: number; code?: string; message?: string };
  return (
    value.status === 429 ||
    value.code === "over_email_send_rate_limit" ||
    /rate.?limit|too many requests/i.test(value.message ?? "")
  );
}

export default function Login({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [method, setMethod] = useState<LoginMethod>("password");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [otpCooldownUntil, setOtpCooldownUntil] = useState(readOtpCooldown);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (method === "password") {
        const { error } = await auth.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
        onClose();
      } else if (sent) {
        const { error } = await auth.auth.verifyOtp({
          email: email.trim(),
          token: otp.trim(),
          type: "email",
        });
        if (error) throw error;
        onClose();
      } else {
        const now = Date.now();
        if (now < otpCooldownUntil) {
          const minutes = Math.max(1, Math.ceil((otpCooldownUntil - now) / 60_000));
          throw new Error(
            `Email request abhi pause hai (${minutes} min tak). Rate limit ke dauran Password login use karo; baar-baar email request mat bhejo.`,
          );
        }

        const shortCooldown = now + OTP_RESEND_COOLDOWN_MS;
        saveOtpCooldown(shortCooldown);
        setOtpCooldownUntil(shortCooldown);
        const { error } = await auth.auth.signInWithOtp({
          email: email.trim(),
          options: {
            shouldCreateUser: false,
            emailRedirectTo: window.location.origin,
          },
        });
        if (error) {
          if (isRateLimitError(error)) {
            const backoffUntil = Date.now() + OTP_RATE_LIMIT_BACKOFF_MS;
            saveOtpCooldown(backoffUntil);
            setOtpCooldownUntil(backoffUntil);
            throw new Error(
              "Supabase ne email-send rate limit lagayi hai. Is browser mein email request 60 min ke liye pause ki hai; exact server reset time alag ho sakta hai. Abhi Password login use karo.",
            );
          }
          throw error;
        }
        setSent(true);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message.slice(0, 240) : "Login fail hua.",
      );
    } finally {
      setBusy(false);
    }
  }

  function changeMethod(next: LoginMethod) {
    setMethod(next);
    setError("");
  }

  return (
    <Dialog title="Owner authentication" onClose={onClose}>
      <div className="login-symbol">
        <ShieldCheck size={36} />
      </div>
      <h3>Private by design.</h3>
      <p className="muted">
        Supabase mein registered account aur controller ki private owner allowlist
        dono required hain.
      </p>
      <div className="login-methods" role="group" aria-label="Login method">
        <button
          type="button"
          className={`btn${method === "password" ? " primary" : ""}`}
          aria-pressed={method === "password"}
          disabled={busy}
          onClick={() => changeMethod("password")}
        >
          <KeyRound size={15} /> Password
        </button>
        <button
          type="button"
          className={`btn${method === "email" ? " primary" : ""}`}
          aria-pressed={method === "email"}
          disabled={busy}
          onClick={() => changeMethod("email")}
        >
          <Mail size={15} /> Email code
        </button>
      </div>
      <form onSubmit={submit}>
        <label className="field">
          Owner email
          <input
            type="email"
            autoComplete="email"
            required
            disabled={busy || (method === "email" && sent)}
            placeholder="you@example.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setSent(false);
              setOtp("");
            }}
          />
        </label>
        {method === "password" && (
          <label className="field">
            Supabase password
            <input
              type="password"
              autoComplete="current-password"
              required
              disabled={busy}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {method === "email" && sent && (
          <label className="field">
            Email login code
            <input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6,10}"
              maxLength={10}
              placeholder="Login code"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            />
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary full" disabled={busy} type="submit">
          {busy
            ? "Login ho raha hai…"
            : method === "password"
              ? "Password se login"
              : sent
                ? "Verify login code"
                : "Email code bhejo"}{" "}
          {method === "password" ? (
            <KeyRound size={16} />
          ) : sent ? (
            <ArrowRight size={16} />
          ) : (
            <Mail size={16} />
          )}
        </button>
      </form>
      {method === "password" ? (
        <p className="help">
          Email request nahi bhejega. Sirf apne existing verified Supabase Auth
          account ka password use karo; signup ya password app mein save nahi hota.
        </p>
      ) : sent ? (
        <>
          <p className="help">
            Numeric code ke liye Supabase Magic Link template mein{" "}
            <code>{"{{ .Token }}"}</code> hona chahiye. Code sirf yahan enter karo,
            chat mein nahi.
          </p>
          <button
            className="text-btn"
            disabled={busy}
            onClick={() => {
              setSent(false);
              setOtp("");
            }}
          >
            Email code dobara mangao
          </button>
        </>
      ) : (
        <p className="help">
          OTP email bhejna rate-limited ho sakta hai. Agar Supabase email limit
          aaye to retry na karo; Password option use karo.
        </p>
      )}
      <div className="notice">
        Password ya code se sign-in ke baad bhi controller ki server-side owner
        allowlist check hoti hai. Public signup aur automatic admin access disabled
        hain.
      </div>
    </Dialog>
  );
}
