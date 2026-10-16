import { type ReactNode } from 'react';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { ThemeProvider } from '@/components/ui/theme-provider';
import { Toaster } from '@/components/ui/sonner';

import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  adjustFontFallback: false,
  variable: '--font-Inter'
});

const metadataUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
  process.env.NEXT_PUBLIC_VERCEL_URL?.trim() ||
  'http://localhost:3000/';

export const metadata: Metadata = {
  metadataBase: new URL(
    /^https?:\/\//i.test(metadataUrl) ? metadataUrl : `https://${metadataUrl}`
  ),
  title: 'AI Chatbot with RAG',
  description: 'Upload documents and chat with AI using their content.'
};

export default async function RootLayout({
  children,
  modal
}: {
  children: ReactNode;
  modal: ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.className}>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster richColors />
          {modal}
        </ThemeProvider>
      </body>
    </html>
  );
}
