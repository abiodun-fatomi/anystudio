'use client';
/**
 * The signed-in route group. AppProvider knows who is here and what they
 * can spend; ToastProvider gives every screen one place to say what
 * happened; AppShell draws the frame. Screens under here render inside
 * <main> and nothing else.
 */
import { AppProvider } from '@/lib/app-context';
import { ToastProvider } from '@/components/ui';
import { AppShell } from '@/components/shell/AppShell';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <ToastProvider>
        <AppShell>{children}</AppShell>
      </ToastProvider>
    </AppProvider>
  );
}
