"use client";

import { useState, useEffect } from "react";

interface LandingNavbarProps {
  onNavigateAuth: () => void;
}

export default function LandingNavbar({ onNavigateAuth }: LandingNavbarProps) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollToSection = (id: string) => {
    setMobileMenuOpen(false);
    if (id === "home") {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-black/90 backdrop-blur-md py-3.5 border-b border-neutral-800"
          : "bg-black/70 backdrop-blur-sm py-4 border-b border-white/10"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between">
          {/* LEFT: Uploaded NEXUSS Logo Asset & Brand Name */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => scrollToSection("home")}
              className="flex items-center gap-3 group text-left focus:outline-none"
            >
              <div className="relative w-8 h-8 flex items-center justify-center shrink-0">
                <img
                  src="/nexuss-logo.png"
                  alt="NEXUSS Logo"
                  className="w-full h-full object-contain transition-transform group-hover:scale-105"
                />
              </div>
              <span className="text-xl font-extrabold tracking-wider text-white font-sans uppercase">
                NEXUSS
              </span>
            </button>
          </div>

          {/* CENTER: Navigation Links */}
          <nav className="hidden md:flex items-center gap-8 text-sm font-medium">
            <button
              onClick={() => scrollToSection("home")}
              className="text-neutral-300 hover:text-white transition-colors cursor-pointer focus:outline-none"
            >
              Home
            </button>
            <button
              onClick={() => scrollToSection("procedure")}
              className="text-neutral-300 hover:text-white transition-colors cursor-pointer focus:outline-none"
            >
              Procedure
            </button>
            <button
              onClick={() => scrollToSection("security")}
              className="text-neutral-300 hover:text-white transition-colors cursor-pointer focus:outline-none"
            >
              Security
            </button>
          </nav>

          {/* RIGHT: Action Buttons */}
          <div className="hidden md:flex items-center gap-4">
            <button
              onClick={onNavigateAuth}
              className="text-sm font-medium text-neutral-300 hover:text-white px-4 py-2 transition-colors cursor-pointer"
            >
              Login
            </button>
            <button
              onClick={onNavigateAuth}
              className="text-sm font-semibold text-black bg-white hover:bg-neutral-200 px-5 py-2.5 rounded-lg transition-all shadow-sm cursor-pointer"
            >
              Get Started
            </button>
          </div>

          {/* Mobile Menu Toggle Button */}
          <div className="md:hidden flex items-center">
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-2 text-neutral-400 hover:text-white focus:outline-none"
              aria-label="Toggle menu"
            >
              {mobileMenuOpen ? (
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Drawer Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden bg-black/95 border-b border-neutral-800 px-4 pt-4 pb-6 space-y-4 backdrop-blur-xl">
          <nav className="flex flex-col space-y-3 text-base font-medium">
            <button
              onClick={() => scrollToSection("home")}
              className="text-left text-neutral-300 hover:text-white py-1.5 transition-colors"
            >
              Home
            </button>
            <button
              onClick={() => scrollToSection("procedure")}
              className="text-left text-neutral-300 hover:text-white py-1.5 transition-colors"
            >
              Procedure
            </button>
            <button
              onClick={() => scrollToSection("security")}
              className="text-left text-neutral-300 hover:text-white py-1.5 transition-colors"
            >
              Security
            </button>
          </nav>
          <div className="pt-4 border-t border-neutral-800 flex flex-col gap-3">
            <button
              onClick={() => {
                setMobileMenuOpen(false);
                onNavigateAuth();
              }}
              className="w-full text-center text-neutral-300 hover:text-white py-2 border border-neutral-800 rounded-lg"
            >
              Login
            </button>
            <button
              onClick={() => {
                setMobileMenuOpen(false);
                onNavigateAuth();
              }}
              className="w-full text-center text-black bg-white hover:bg-neutral-200 font-semibold py-2.5 rounded-lg"
            >
              Get Started
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
