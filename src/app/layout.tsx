import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "Nexuss",
    template: "%s · Nexuss"
  },
  description: "Nexuss AI chat app",
  icons: {
    icon: "/nexuss-logo.png"
  }
};

// Mobile-first viewport: no user scaling lock, safe-area insets are exposed
// (viewport-fit=cover) and Chrome for Android resizes the layout viewport with
// the software keyboard so the composer is never hidden behind it.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#171717" }
  ]
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
            __html: `try{(function(){var t=JSON.parse(window.localStorage.getItem("theme")||"null");if(t==="light"){document.documentElement.classList.remove("dark")}else{document.documentElement.classList.add("dark")}})()}catch(e){document.documentElement.classList.add("dark")}`
          }}
        />
      </head>
      <body className={`${inter.className} min-h-screen`}>
        {children}
      </body>
    </html>
  );
}
