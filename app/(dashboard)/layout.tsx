import 'server-only';
import React from 'react';
import { type Metadata } from 'next';
import { AppSidebar } from './components/app-sidebar';
import { createServerSupabaseClient } from '@/lib/server/server';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger
} from '@/components/ui/sidebar';
import { isAfter } from 'date-fns';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  robots: { follow: false, index: false }
};

type UserRow = {
  id: string;
  role: string | null;
  full_name: string | null;
  email: string | null;
};

type SubscriptionRow = {
  status: string | null;
  stripe_current_period_end: string | null;
};

async function getUserData() {
  try {
    const supabase = await createServerSupabaseClient();

    // 1) Get logged-in user from auth
    const { data: authData, error: authErr } = await supabase.auth.getUser();
    if (authErr) {
      console.error('Auth error:', authErr);
      return null;
    }
    const authUser = authData?.user;
    if (!authUser) {
      // Not signed in
      return null;
    }

    // 2) Fetch user profile row by id
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('id, role, full_name, email')
      .eq('id', authUser.id)
      .maybeSingle<UserRow>();

    if (userError) {
      console.error('Error fetching user profile:', userError);
      // Still allow rendering children
      return {
        isAdmin: false,
        user: {
          name: authUser.email?.split('@')[0] || 'User',
          email: authUser.email || '',
          avatar: '/avatars/user.jpg'
        },
        hasActiveSubscription: false
      };
    }

    const isAdmin = (userData?.role || '').toLowerCase() === 'admin';

    // 3) Fetch subscription separately (so missing FK/table doesn't crash)
    let hasActiveSubscription = false;

    try {
      const { data: subData, error: subErr } = await supabase
        .from('subscriptions')
        .select('status, stripe_current_period_end')
        .eq('user_id', authUser.id)
        .maybeSingle<SubscriptionRow>();

      if (!subErr && subData?.status && subData?.stripe_current_period_end) {
        const end = new Date(subData.stripe_current_period_end);
        hasActiveSubscription =
          (subData.status === 'active' ||
            subData.status === 'trialing' ||
            subData.status === 'canceled') &&
          isAfter(end, new Date());
      }
    } catch {
      // If subscriptions table doesn't exist yet, just ignore.
      hasActiveSubscription = false;
    }

    const email = userData?.email || authUser.email || '';
    const user = {
      name: userData?.full_name || email.split('@')[0] || 'User',
      email,
      avatar: '/avatars/user.jpg'
    };

    return { isAdmin, user, hasActiveSubscription };
  } catch (error) {
    console.error('Error checking user data:', error);
    return null;
  }
}

export default async function Layout({
  children
}: {
  children: React.ReactNode;
}) {
  const userData = await getUserData();

  // If not signed in, just render content
  if (!userData) return <>{children}</>;

  const { isAdmin, user, hasActiveSubscription } = userData;

  return (
    <SidebarProvider className="flex">
      <AppSidebar
        isAdmin={isAdmin}
        user={user}
        hasActiveSubscription={hasActiveSubscription}
      />
      <SidebarInset>{children}</SidebarInset>
      <div className="fixed bottom-4 right-4 z-50 sm:hidden">
        <SidebarTrigger />
      </div>
    </SidebarProvider>
  );
}
