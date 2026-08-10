"use client";

interface FinalCTAProps {
  onNavigateAuth: () => void;
}

export default function FinalCTA({ onNavigateAuth }: FinalCTAProps) {
  const handleExplorePlatform = () => {
    const el = document.getElementById("procedure");
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <section className="py-28 px-4 sm:px-6 lg:px-8 bg-black border-t border-neutral-900 relative overflow-hidden">
      {/* Soft ambient lighting */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[300px] bg-white/[0.03] blur-[120px] rounded-full pointer-events-none" />

      <div className="relative z-10 max-w-4xl mx-auto text-center flex flex-col items-center space-y-8">
        <div className="relative w-12 h-12 flex items-center justify-center shrink-0">
          <img
            src="/nexuss-logo.png"
            alt="NEXUSS Logo"
            className="w-full h-full object-contain"
          />
        </div>

        {/* Headline */}
        <h2 className="text-4xl sm:text-6xl font-extrabold text-white tracking-tight leading-tight font-sans">
          Build on the <br />
          <span className="text-neutral-400">Intelligence Layer.</span>
        </h2>

        {/* Supporting Text */}
        <p className="max-w-xl text-neutral-400 text-base sm:text-lg leading-relaxed">
          Connect your AI infrastructure. Build intelligent applications. Create what comes next.
        </p>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center gap-4 w-full sm:w-auto pt-4">
          <button
            onClick={onNavigateAuth}
            className="w-full sm:w-auto px-8 py-4 rounded-xl bg-white text-black font-semibold text-base hover:bg-neutral-200 transition-all shadow-lg hover:shadow-white/10 cursor-pointer flex items-center justify-center gap-2 group"
          >
            Get Started
            <span className="transition-transform group-hover:translate-x-1">→</span>
          </button>
          <button
            onClick={handleExplorePlatform}
            className="w-full sm:w-auto px-8 py-4 rounded-xl bg-neutral-950 hover:bg-neutral-900 text-white font-medium text-base border border-neutral-800 transition-all cursor-pointer"
          >
            Explore the Platform →
          </button>
        </div>
      </div>
    </section>
  );
}
