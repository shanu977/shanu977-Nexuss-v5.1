"use client";

export default function ApiInfrastructureSection() {
  return (
    <section className="py-24 px-4 sm:px-6 lg:px-8 bg-black border-t border-neutral-900">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
        {/* LEFT SIDE: Text & Bullet Points */}
        <div className="space-y-8">
          <div className="space-y-4">
            <span className="text-xs font-mono text-neutral-400 uppercase tracking-widest block">
              API INFRASTRUCTURE
            </span>
            <h2 className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight leading-tight">
              Your APIs. <br />
              <span className="text-neutral-400">One Connection Layer.</span>
            </h2>
            <p className="text-neutral-400 text-base sm:text-lg leading-relaxed">
              Centralize API connections, credentials, authentication, and service integrations without rebuilding infrastructure for every application.
            </p>
          </div>

          <div className="space-y-3 pt-2 font-mono text-sm">
            {[
              "Unified credential storage",
              "Single endpoint per service",
              "Secure authentication",
              "Cross-project reuse",
            ].map((bullet, idx) => (
              <div
                key={idx}
                className="flex items-center gap-3 p-3 rounded-lg bg-neutral-950 border border-neutral-800 text-neutral-200"
              >
                <span className="text-emerald-400 font-bold">•</span>
                <span>{bullet}</span>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT SIDE: Premium Rectangular API Console Mockup */}
        <div className="relative rounded-2xl bg-neutral-950 border border-neutral-800 p-6 shadow-2xl overflow-hidden font-mono text-xs group hover:border-neutral-700 transition-colors">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-neutral-800 pb-4 mb-6">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-neutral-700" />
              <div className="w-3 h-3 rounded-full bg-neutral-700" />
              <div className="w-3 h-3 rounded-full bg-neutral-700" />
              <span className="text-xs text-neutral-400 ml-2">NEXUSS API CONSOLE</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-xs font-semibold text-emerald-400">STATUS: Connected</span>
            </div>
          </div>

          {/* Console Details */}
          <div className="space-y-4">
            <div className="bg-neutral-900/90 p-4 rounded-xl border border-neutral-800 space-y-3">
              <div className="flex justify-between items-center border-b border-neutral-800 pb-2">
                <span className="text-neutral-400">API KEY</span>
                <span className="text-white font-mono font-bold tracking-widest">••••••••••••••••</span>
              </div>
              <div className="flex justify-between items-center border-b border-neutral-800 pb-2">
                <span className="text-neutral-400">ENDPOINT</span>
                <span className="text-emerald-400 font-mono font-bold">/api/v1/connect</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-neutral-400">AUTHENTICATION</span>
                <span className="text-white bg-white/10 px-2 py-0.5 rounded text-[11px]">Secure (TLS 1.3)</span>
              </div>
            </div>

            {/* Connected Services */}
            <div className="bg-neutral-900/50 p-4 rounded-xl border border-neutral-800/80 space-y-2">
              <div className="text-[11px] text-neutral-500 uppercase tracking-wider mb-2 font-bold">
                CONNECTED SERVICES
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {["OpenAI", "GitHub", "Firebase", "PostgreSQL"].map((svc, i) => (
                  <div
                    key={i}
                    className="p-2 rounded bg-neutral-950 border border-neutral-800 text-center text-neutral-300 font-bold text-[11px]"
                  >
                    {svc}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
