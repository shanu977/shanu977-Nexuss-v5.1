"use client";

interface UserProfileProps {
  email: string;
  avatarChar: string;
}

export default function UserProfile({ email, avatarChar }: UserProfileProps) {
  return (
    <div className="flex w-full items-center gap-2.5 rounded-xl p-2 bg-card border border-border">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-xs">
        {avatarChar}
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-medium text-foreground">{email}</span>
        <span className="text-[10px] text-emerald-500 font-semibold">Active Workspace</span>
      </div>
    </div>
  );
}