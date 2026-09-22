import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Lock, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Logo } from "@/components/Logo";
import { MIN_CLINIC_PASSWORD_LENGTH } from "@shared/const";
import { validateChangePasswordForm } from "@/lib/changePasswordValidation";

/** Forced first-login / voluntary password change for clinic staff.
 * Never reachable by owner OAuth — App.tsx redirects owners away. */
export default function ChangePassword({ mustChangePassword }: { mustChangePassword: boolean }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const logoutMutation = trpc.auth.logout.useMutation();
  const handleSignOut = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => { window.location.href = "/login"; },
      onError: () => { window.location.href = "/login"; },
    });
  };

  const changePasswordMutation = trpc.clinic.changePassword.useMutation({
    onSuccess: () => {
      toast.success("Password updated.");
      // Hard navigate so auth state (mustChangePassword) refreshes everywhere.
      window.location.href = "/dashboard";
    },
    onError: (err) => {
      setErrorMsg(err.message || "Could not update password.");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");

    const validationError = validateChangePasswordForm({ currentPassword, newPassword, confirmPassword });
    if (validationError) {
      setErrorMsg(validationError);
      return;
    }

    changePasswordMutation.mutate({ currentPassword, newPassword });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1E3A5F] via-[#152A47] to-[#071e30] flex items-center justify-center p-4">
      <div className="absolute inset-0 opacity-5 pointer-events-none"
        style={{
          backgroundImage: `radial-gradient(circle at 25% 25%, #E8A93C 0%, transparent 50%),
                            radial-gradient(circle at 75% 75%, #E8A93C 0%, transparent 50%)`
        }}
      />

      <div className="relative w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 mb-4">
            <Logo variant="icon" size="xl" className="w-20 h-20 drop-shadow-lg" />
          </div>
          <h1 className="text-2xl font-serif font-bold text-white">NYC Home Rehab</h1>
          <p className="text-[#E8A93C] text-sm mt-1 uppercase tracking-wide">Physical Therapy · Authorization Tracker</p>
        </div>

        <Card className="border-0 shadow-2xl bg-white/95 backdrop-blur-sm">
          <CardHeader className="pb-4 pt-6 px-6">
            <CardTitle className="text-[#1E3A5F] font-serif text-xl font-bold text-center">
              {mustChangePassword ? "Set a New Password" : "Change Password"}
            </CardTitle>
            <CardDescription className="text-center text-[#6B7280]">
              {mustChangePassword
                ? "For security, you must set a new password before continuing."
                : "Enter your current password and choose a new one."}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="currentPassword" className="text-[#1E3A5F] font-medium text-sm">
                  Current Password
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#1E3A5F]/50" />
                  <Input
                    id="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    placeholder="Enter your current password"
                    value={currentPassword}
                    onChange={e => { setCurrentPassword(e.target.value); setErrorMsg(""); }}
                    className="pl-9 border-[#F0E9DC] focus:border-[#1E3A5F] focus:ring-[#1E3A5F]/20 text-[#1E3A5F]"
                    disabled={changePasswordMutation.isPending}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="newPassword" className="text-[#1E3A5F] font-medium text-sm">
                  New Password
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#1E3A5F]/50" />
                  <Input
                    id="newPassword"
                    type="password"
                    autoComplete="new-password"
                    placeholder={`At least ${MIN_CLINIC_PASSWORD_LENGTH} characters`}
                    value={newPassword}
                    onChange={e => { setNewPassword(e.target.value); setErrorMsg(""); }}
                    className="pl-9 border-[#F0E9DC] focus:border-[#1E3A5F] focus:ring-[#1E3A5F]/20 text-[#1E3A5F]"
                    disabled={changePasswordMutation.isPending}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirmPassword" className="text-[#1E3A5F] font-medium text-sm">
                  Confirm New Password
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#1E3A5F]/50" />
                  <Input
                    id="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    placeholder="Re-enter your new password"
                    value={confirmPassword}
                    onChange={e => { setConfirmPassword(e.target.value); setErrorMsg(""); }}
                    className="pl-9 border-[#F0E9DC] focus:border-[#1E3A5F] focus:ring-[#1E3A5F]/20 text-[#1E3A5F]"
                    disabled={changePasswordMutation.isPending}
                  />
                </div>
              </div>

              {errorMsg && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <Button
                type="submit"
                disabled={changePasswordMutation.isPending}
                className="w-full bg-[#1E3A5F] hover:bg-[#152A47] text-white font-semibold py-2.5 rounded-lg transition-all duration-150 active:scale-[0.97] mt-2"
              >
                {changePasswordMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 animate-spin mr-2" />Updating…</>
                ) : (
                  "Update Password"
                )}
              </Button>

              <button
                type="button"
                onClick={handleSignOut}
                className="w-full text-center text-sm text-[#6B7280] hover:text-[#1E3A5F] transition-colors py-1"
              >
                Sign out instead
              </button>
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
