import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Lock, User, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Logo } from "@/components/Logo";

export default function Login() {
  const [, navigate] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const loginMutation = trpc.clinic.login.useMutation({
    onSuccess: () => {
      toast.success("Welcome back!");
      // Hard navigate to force a full page reload so auth state refreshes
      window.location.href = "/";
    },
    onError: (err) => {
      setErrorMsg(err.message || "Invalid username or password");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    if (!username.trim() || !password.trim()) {
      setErrorMsg("Please enter both username and password.");
      return;
    }
    loginMutation.mutate({ username: username.trim(), password });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1E3A5F] via-[#152A47] to-[#071e30] flex items-center justify-center p-4">
      {/* Background pattern */}
      <div className="absolute inset-0 opacity-5 pointer-events-none"
        style={{
          backgroundImage: `radial-gradient(circle at 25% 25%, #E8A93C 0%, transparent 50%),
                            radial-gradient(circle at 75% 75%, #E8A93C 0%, transparent 50%)`
        }}
      />

      <div className="relative w-full max-w-md">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 mb-4">
            <Logo variant="icon" size="xl" className="w-20 h-20 drop-shadow-lg" />
          </div>
          <h1 className="text-2xl font-serif font-bold text-white">NYC Home Rehab</h1>
          <p className="text-[#E8A93C] text-sm mt-1 uppercase tracking-wide">Physical Therapy · ASH Authorization Tracker</p>
        </div>

        <Card className="border-0 shadow-2xl bg-white/95 backdrop-blur-sm">
          <CardHeader className="pb-4 pt-6 px-6">
            <CardTitle className="text-[#1E3A5F] font-serif text-xl font-bold text-center">Staff Login</CardTitle>
            <CardDescription className="text-center text-[#6B7280]">
              Enter your credentials to access the dashboard
            </CardDescription>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Username */}
              <div className="space-y-1.5">
                <Label htmlFor="username" className="text-[#1E3A5F] font-medium text-sm">
                  Username
                </Label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#1E3A5F]/50" />
                  <Input
                    id="username"
                    type="text"
                    autoComplete="username"
                    placeholder="Enter your username"
                    value={username}
                    onChange={e => { setUsername(e.target.value); setErrorMsg(""); }}
                    className="pl-9 border-[#F0E9DC] focus:border-[#1E3A5F] focus:ring-[#1E3A5F]/20 text-[#1E3A5F]"
                    disabled={loginMutation.isPending}
                  />
                </div>
              </div>

              {/* Password */}
              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-[#1E3A5F] font-medium text-sm">
                  Password
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#1E3A5F]/50" />
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={e => { setPassword(e.target.value); setErrorMsg(""); }}
                    className="pl-9 border-[#F0E9DC] focus:border-[#1E3A5F] focus:ring-[#1E3A5F]/20 text-[#1E3A5F]"
                    disabled={loginMutation.isPending}
                  />
                </div>
              </div>

              {/* Error message */}
              {errorMsg && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {/* Submit */}
              <Button
                type="submit"
                disabled={loginMutation.isPending}
                className="w-full bg-[#1E3A5F] hover:bg-[#152A47] text-white font-semibold py-2.5 rounded-lg transition-all duration-150 active:scale-[0.97] mt-2"
              >
                {loginMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 animate-spin mr-2" />Signing in…</>
                ) : (
                  "Sign In"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-white/40 text-xs mt-6">
          Physical Therapy Clinic Dashboard · Authorized Access Only
        </p>
      </div>
    </div>
  );
}
