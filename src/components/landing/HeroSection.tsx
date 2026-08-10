"use client";

import ConnectionBackground from "./ConnectionBackground";

interface HeroSectionProps {
  onNavigateAuth: () => void;
}

export default function HeroSection({ onNavigateAuth }: HeroSectionProps) {
  const handleScrollToProcedure = () => {
    const el = document.getElementById("procedure");
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <section
      id="home"
      className="relative min-h-screen flex flex-col justify-center items-center pt-28 pb-20 px-4 sm:px-6 lg:px-8 bg-black overflow-hidden"
    >
      {/* Central Black AI Core + Curved Network Lines Background Animation */}
      <ConnectionBackground />

      <div className="relative z-10 max-w-5xl mx-auto text-center flex flex-col items-center">
        {/* Small Eyebrow Label */}
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-neutral-950/80 border border-neutral-800 text-xs font-mono tracking-widest text-neutral-300 uppercase mb-8 backdrop-blur-md">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          THE INTELLIGENCE LAYER FOR MODERN WORK
        </div>

        {/* Main Display Headline */}
        <h1 className="text-5xl sm:text-7xl lg:text-8xl font-extrabold tracking-tight text-white leading-[1.05] mb-8 font-sans">
          Think Faster.
          <br />
          <span className="bg-gradient-to-r from-white via-neutral-200 to-neutral-500 bg-clip-text text-transparent">
            Build Smarter.
          </span>
        </h1>

        {/* Concise Supporting Description */}
        <p className="max-w-2xl text-base sm:text-xl text-neutral-400 font-normal leading-relaxed mb-10 text-center">
          Orchestrate multi-model AI conversations, manage context seamlessly, and power intelligent user experiences with an enterprise-ready platform.
        </p>

        {/* Hero Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center gap-4 w-full sm:w-auto">
          <button
            onClick={onNavigateAuth}
            className="w-full sm:w-auto px-8 py-4 rounded-xl bg-white text-black font-semibold text-base hover:bg-neutral-200 transition-all duration-200 shadow-lg shadow-white/5 hover:shadow-white/20 active:scale-[0.98] cursor-pointer flex items-center justify-center gap-2 group"
          >
            Get Started
            <span className="transition-transform group-hover:translate-x-1">→</span>
          </button>
          <button
            onClick={handleScrollToProcedure}
            className="w-full sm:w-auto px-8 py-4 rounded-xl bg-neutral-950 hover:bg-neutral-900 text-white font-medium text-base border border-neutral-800 transition-all duration-200 cursor-pointer flex items-center justify-center gap-2"
          >
            How It Works
            <span>↓</span>
          </button>
        </div>

        {/* Hero Platform Metrics Row */}
        <div className="mt-16 sm:mt-24 grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-8 pt-8 border-t border-neutral-900 w-full max-w-3xl">
          <div className="text-center p-3 bg-neutral-950/40 rounded-xl border border-neutral-900/80">
            <div className="text-[11px] font-mono text-neutral-500 uppercase tracking-wider mb-1">
              LATENCY
            </div>
            <div className="text-lg sm:text-xl font-bold text-white font-mono">&lt; 25ms</div>
          </div>
          <div className="text-center p-3 bg-neutral-950/40 rounded-xl border border-neutral-900/80">
            <div className="text-[11px] font-mono text-neutral-500 uppercase tracking-wider mb-1">
              ORCHESTRATION
            </div>
            <div className="text-lg sm:text-xl font-bold text-white font-mono">Multi-Model</div>
          </div>
          <div className="text-center p-3 bg-neutral-950/40 rounded-xl border border-neutral-900/80">
            <div className="text-[11px] font-mono text-neutral-500 uppercase tracking-wider mb-1">
              SECURITY
            </div>
            <div className="text-lg sm:text-xl font-bold text-white font-mono">Isolated Context</div>
          </div>
          <div className="text-center p-3 bg-neutral-950/40 rounded-xl border border-neutral-900/80">
            <div className="text-[11px] font-mono text-neutral-500 uppercase tracking-wider mb-1">
              UPTIME
            </div>
            <div className="text-lg sm:text-xl font-bold text-white font-mono">99.99%</div>
          </div>
        </div>
      </div>
    </section>
  );
}
