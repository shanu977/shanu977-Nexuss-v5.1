"use client";

interface LandingFooterProps {
  onNavigateAuth: () => void;
}

export default function LandingFooter({ onNavigateAuth }: LandingFooterProps) {
  const scrollTo = (id: string) => {
    if (id === "home") {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <footer className="bg-black border-t border-neutral-900 pt-16 pb-12 px-4 sm:px-6 lg:px-8 text-sm">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-5 gap-10 pb-12 border-b border-neutral-900">
        {/* Brand Column */}
        <div className="md:col-span-2 space-y-4">
          <div className="flex items-center gap-3">
            <div className="relative w-7 h-7 flex items-center justify-center shrink-0">
              <img
                src="/nexuss-logo.png"
                alt="NEXUSS Logo"
                className="w-full h-full object-contain"
              />
            </div>
            <span className="text-lg font-extrabold tracking-wider text-white uppercase font-sans">
              NEXUSS
            </span>
          </div>
          <p className="text-neutral-400 text-xs sm:text-sm max-w-sm leading-relaxed">
            The intelligence layer for modern work. Connecting AI infrastructure, APIs, and models into a single enterprise layer.
          </p>
        </div>

        {/* Links Column 1: PRODUCT */}
        <div className="space-y-3">
          <div className="text-xs font-mono text-white font-bold uppercase tracking-wider">
            PRODUCT
          </div>
          <ul className="space-y-2 text-neutral-400 text-xs">
            <li>
              <button onClick={() => scrollTo("home")} className="hover:text-white transition-colors cursor-pointer">
                Home
              </button>
            </li>
            <li>
              <button onClick={() => scrollTo("procedure")} className="hover:text-white transition-colors cursor-pointer">
                Procedure
              </button>
            </li>
            <li>
              <button onClick={() => scrollTo("security")} className="hover:text-white transition-colors cursor-pointer">
                Security
              </button>
            </li>
          </ul>
        </div>

        {/* Links Column 2: PLATFORM */}
        <div className="space-y-3">
          <div className="text-xs font-mono text-white font-bold uppercase tracking-wider">
            PLATFORM
          </div>
          <ul className="space-y-2 text-neutral-400 text-xs">
            <li>
              <button onClick={() => scrollTo("procedure")} className="hover:text-white transition-colors cursor-pointer">
                API Infrastructure
              </button>
            </li>
            <li>
              <button onClick={() => scrollTo("procedure")} className="hover:text-white transition-colors cursor-pointer">
                Developer Experience
              </button>
            </li>
            <li>
              <button onClick={() => scrollTo("procedure")} className="hover:text-white transition-colors cursor-pointer">
                Technologies
              </button>
            </li>
          </ul>
        </div>

        {/* Links Column 3: ACCOUNT */}
        <div className="space-y-3">
          <div className="text-xs font-mono text-white font-bold uppercase tracking-wider">
            ACCOUNT
          </div>
          <ul className="space-y-2 text-neutral-400 text-xs">
            <li>
              <button onClick={onNavigateAuth} className="hover:text-white transition-colors cursor-pointer">
                Login
              </button>
            </li>
            <li>
              <button onClick={onNavigateAuth} className="hover:text-white transition-colors cursor-pointer">
                Get Started
              </button>
            </li>
          </ul>
        </div>
      </div>

      {/* Bottom Footer */}
      <div className="max-w-7xl mx-auto pt-8 flex flex-col sm:flex-row items-center justify-between text-xs text-neutral-500 gap-4">
        <div>
          © 2026 NEXUSS. All rights reserved.
        </div>
        <div className="flex items-center gap-6">
          <span className="hover:text-neutral-400 cursor-pointer">Privacy Policy</span>
          <span className="hover:text-neutral-400 cursor-pointer">Terms of Service</span>
          <span className="hover:text-neutral-400 cursor-pointer">Security Policy</span>
        </div>
      </div>
    </footer>
  );
}
