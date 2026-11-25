import { useState, type FormEvent } from "react";
import { Mail, ShieldCheck, ArrowRight } from "lucide-react";
import { auth } from "../api";
import { Dialog } from "./ui";
export default function Login({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastSent, setLastSent] = useState(0);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (sent) {
        const { error } = await auth.auth.verifyOtp({
          email: email.trim(),
          token: otp.trim(),
          type: "email",
        });
        if (error) throw error;
        onClose();
      } else {
        if (Date.now() - lastSent < 60000)
          throw new Error(
            "Naya email request karne se pehle 60 seconds wait karo.",
          );
        const { error } = await auth.auth.signInWithOtp({
          email: email.trim(),
          options: {
            shouldCreateUser: false,
            emailRedirectTo: window.location.origin,
          },
        });
        if (error) throw error;
        setLastSent(Date.now());
        setSent(true);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message.slice(0, 200) : "Login fail hua.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Owner authentication" onClose={onClose}>
      <div className="login-symbol">
        <ShieldCheck size={36} />
      </div>
      <h3>Private by design.</h3>
      <p className="muted">
        Supabase mein registered aur controller allowlist mein approved account
        hi control kar sakta hai.
      </p>
      <form onSubmit={submit}>
        <label className="field">
          Owner email
          <input
            type="email"
            autoComplete="email"
            required
            disabled={sent || busy}
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {sent && (
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
            ? "Verify ho raha hai…"
            : sent
              ? "Verify login"
              : "Login email bhejo"}{" "}
          {sent ? <ArrowRight size={16} /> : <Mail size={16} />}
        </button>
      </form>
      {sent && (
        <>
          <p className="help">
            Code tabhi milega jab Supabase Magic Link template mein OTP enabled
            ho. Agar email mein link hai, configured redirect par usse login
            karo. Code yahan paste karo, chat mein nahi.
          </p>
          <button
            className="text-btn"
            disabled={busy}
            onClick={() => {
              setSent(false);
              setOtp("");
            }}
          >
            Email badlo / resend
          </button>
        </>
      )}
      <div className="notice">
        Owner account setup pending ho to login nahi chalega. Public signup aur
        automatic admin access disabled hain.
      </div>
    </Dialog>
  );
}
