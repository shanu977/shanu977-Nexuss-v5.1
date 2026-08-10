import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "Chatbot",
    template: "%s · Chatbot"
  },
  description: "Local AI chat app"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{(function(){var t=JSON.parse(window.localStorage.getItem("theme")||"null");if(t==="dark"){document.documentElement.classList.add("dark")}})()}catch(e){}`
          }}
        />
      </head>
      <body className={`${inter.className} min-h-screen`}>
        {children}
      </body>
    </html>
  );
}
