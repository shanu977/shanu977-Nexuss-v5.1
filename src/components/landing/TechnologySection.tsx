"use client";

export default function TechnologySection() {
  // Real project technologies with authentic brand colors and SVG logos
  const row1Techs = [
    {
      name: "React 19",
      category: "UI Engine",
      color: "#61DAFB",
      iconSvg: (
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
          <ellipse cx="12" cy="12" rx="10" ry="4.5" stroke="#61DAFB" strokeWidth="1.5" transform="rotate(0 12 12)" />
          <ellipse cx="12" cy="12" rx="10" ry="4.5" stroke="#61DAFB" strokeWidth="1.5" transform="rotate(60 12 12)" />
          <ellipse cx="12" cy="12" rx="10" ry="4.5" stroke="#61DAFB" strokeWidth="1.5" transform="rotate(120 12 12)" />
          <circle cx="12" cy="12" r="2" fill="#61DAFB" />
        </svg>
      ),
    },
    {
      name: "TypeScript",
      category: "Language",
      color: "#3178C6",
      iconSvg: (
        <div className="w-5 h-5 rounded bg-[#3178C6] text-white flex items-center justify-center font-bold text-[10px] font-mono">
          TS
        </div>
      ),
    },
    {
      name: "Next.js 15",
      category: "App Router Framework",
      color: "#FFFFFF",
      iconSvg: (
        <div className="w-5 h-5 rounded-full bg-white text-black flex items-center justify-center font-extrabold text-[10px] font-mono">
          N
        </div>
      ),
    },
    {
      name: "Tailwind CSS",
      category: "Styling Engine",
      color: "#06B6D4",
      iconSvg: (
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="#06B6D4">
          <path d="M12 6c-3.3 0-5.5 1.7-6.6 5 1.1-1.7 2.4-2.2 3.9-1.7 1.1.4 1.8 1.2 2.7 2.1C13.4 12.8 15 14.4 19 14.4c3.3 0 5.5-1.7 6.6-5-1.1 1.7-2.4 2.2-3.9 1.7-1.1-.4-1.8-1.2-2.7-2.1C17.6 7.6 16 6 12 6zm-6.6 6c-3.3 0-5.5 1.7-6.6 5 1.1-1.7 2.4-2.2 3.9-1.7 1.1.4 1.8 1.2 2.7 2.1C6.8 18.8 8.4 20.4 12.4 20.4c3.3 0 5.5-1.7 6.6-5-1.1 1.7-2.4 2.2-3.9 1.7-1.1-.4-1.8-1.2-2.7-2.1-1.4-1.4-3-3-7-3z" />
        </svg>
      ),
    },
    {
      name: "Zustand",
      category: "State Management",
      color: "#A5B4FC",
      iconSvg: (
        <div className="w-5 h-5 rounded bg-indigo-500/20 text-indigo-300 flex items-center justify-center font-bold text-[10px] font-mono border border-indigo-500/40">
          Z
        </div>
      ),
    },
    {
      name: "Vitest",
      category: "Testing Runner",
      color: "#FCC72B",
      iconSvg: (
        <div className="w-5 h-5 rounded bg-[#FCC72B]/20 text-[#FCC72B] flex items-center justify-center font-bold text-[10px] font-mono border border-[#FCC72B]/40">
          V
        </div>
      ),
    },
  ];

  const row2Techs = [
    {
      name: "Python 3.12",
      category: "Backend Language",
      color: "#3776AB",
      iconSvg: (
        <svg className="w-5 h-5" viewBox="0 0 24 24">
          <path fill="#3776AB" d="M11.9 2c-4.4 0-4.1 1.9-4.1 1.9v2h4.2v.6H6.1s-2.1-.2-2.1 4.1 1.8 4.2 1.8 4.2h1.1v-1.5s-.1-1.8 1.8-1.8h3.2s1.7 0 1.7-1.7V4.3s.3-2.3-1.7-2.3z" />
          <path fill="#FFD43B" d="M12.1 22c4.4 0 4.1-1.9 4.1-1.9v-2h-4.2v-.6h5.9s2.1.2 2.1-4.1-1.8-4.2-1.8-4.2h-1.1v1.5s.1 1.8-1.8 1.8h-3.2s-1.7 0-1.7 1.7v3.7s-.3 2.3 1.7 2.3z" />
        </svg>
      ),
    },
    {
      name: "FastAPI",
      category: "Async API Engine",
      color: "#009688",
      iconSvg: (
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="#009688">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
      ),
    },
    {
      name: "Firebase Auth",
      category: "Identity Provider",
      color: "#FFCA28",
      iconSvg: (
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="#FFCA28">
          <path d="M3.8 15.3l5.5-10.4 3.7 7-9.2 3.4zm10.7-9.4l4.7 8.9-10.7 4 6-12.9z" />
        </svg>
      ),
    },
    {
      name: "SQLAlchemy",
      category: "ORM & Schema",
      color: "#D71F27",
      iconSvg: (
        <div className="w-5 h-5 rounded bg-[#D71F27]/20 text-[#D71F27] flex items-center justify-center font-bold text-[10px] font-mono border border-[#D71F27]/40">
          SQL
        </div>
      ),
    },
    {
      name: "PostgreSQL & SQLite",
      category: "Database Layer",
      color: "#4169E1",
      iconSvg: (
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="#4169E1">
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm1 14.5h-2v-2h2v2zm0-4h-2V7h2v5.5z" />
        </svg>
      ),
    },
    {
      name: "Pydantic V2",
      category: "Data Validation",
      color: "#E92063",
      iconSvg: (
        <div className="w-5 h-5 rounded bg-[#E92063]/20 text-[#E92063] flex items-center justify-center font-bold text-[10px] font-mono border border-[#E92063]/40">
          PYD
        </div>
      ),
    },
  ];

  return (
    <section className="py-24 bg-black border-t border-neutral-900 overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mb-12 text-center">
        <span className="text-xs font-mono text-neutral-400 uppercase tracking-widest block mb-3">
          BUILT WITH MODERN TECHNOLOGY
        </span>
        <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight">
          NEXUSS Core Stack
        </h2>
        <p className="text-neutral-400 text-sm sm:text-base mt-4 max-w-xl mx-auto">
          Built upon high-performance, industry-proven frameworks for absolute reliability and speed.
        </p>
      </div>

      <div className="space-y-6 w-full relative">
        {/* Soft edge blur masks */}
        <div className="absolute top-0 bottom-0 left-0 w-24 bg-gradient-to-r from-black to-transparent z-10 pointer-events-none" />
        <div className="absolute top-0 bottom-0 right-0 w-24 bg-gradient-to-l from-black to-transparent z-10 pointer-events-none" />

        {/* Row 1: Right -> Left Continuous Marquee */}
        <div className="overflow-hidden w-full">
          <div className="animate-marquee-left flex gap-4">
            {[...row1Techs, ...row1Techs, ...row1Techs].map((tech, index) => (
              <div
                key={`r1-${index}`}
                className="flex items-center gap-3 px-5 py-3.5 bg-neutral-950 border border-neutral-800 rounded-xl hover:border-neutral-700 transition-all whitespace-nowrap shadow-sm group"
              >
                <div className="shrink-0">{tech.iconSvg}</div>
                <div>
                  <div className="text-sm font-bold text-white tracking-wide font-mono flex items-center gap-2">
                    {tech.name}
                  </div>
                  <div className="text-[11px] text-neutral-400 font-sans">
                    {tech.category}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Row 2: Left -> Right Continuous Marquee */}
        <div className="overflow-hidden w-full">
          <div className="animate-marquee-right flex gap-4">
            {[...row2Techs, ...row2Techs, ...row2Techs].map((tech, index) => (
              <div
                key={`r2-${index}`}
                className="flex items-center gap-3 px-5 py-3.5 bg-neutral-950 border border-neutral-800 rounded-xl hover:border-neutral-700 transition-all whitespace-nowrap shadow-sm group"
              >
                <div className="shrink-0">{tech.iconSvg}</div>
                <div>
                  <div className="text-sm font-bold text-white tracking-wide font-mono flex items-center gap-2">
                    {tech.name}
                  </div>
                  <div className="text-[11px] text-neutral-400 font-sans">
                    {tech.category}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
