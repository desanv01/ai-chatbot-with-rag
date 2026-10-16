'use client';
import React from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

const Footer: React.FC = () => {
  const pathname = usePathname();

  // If the current pathname is '/chat'  do not render the component
  if (pathname === '/chat' || /^\/chat\/[^/]+$/.test(pathname)) {
    return null;
  }

  return (
    <footer className="bg-gray-800 text-white mt-auto pt-4">
      <div className="max-w-[1600px] mx-auto px-4 flex flex-wrap justify-center items-start gap-4 pb-4">
        <div className="w-[48%] sm:w-[48%] md:w-[21%] lg:w-[21%] xl:w-[30%] flex flex-col gap-3 p-0">
          <h5 className="text-xl font-bold">AI Chatbot with RAG</h5>
          <p className="text-sm text-white">
            Upload PDFs, ask questions, and revisit saved conversations.
          </p>
        </div>
        <nav
          aria-label="Footer navigation"
          className="w-[42%] sm:w-[42%] md:w-[23%] lg:w-[23%] xl:w-[23%] flex flex-col gap-3 p-0"
        >
          <Link href="/" className="text-sky-300 hover:text-sky-200">
            Home
          </Link>
          <Link href="/chat" className="text-sky-300 hover:text-sky-200">
            Chat
          </Link>
          <Link href="/filer" className="text-sky-300 hover:text-sky-200">
            My Files
          </Link>
          <Link href="/docs" className="text-sky-300 hover:text-sky-200">
            Documentation
          </Link>
        </nav>
      </div>
    </footer>
  );
};

export default Footer;
