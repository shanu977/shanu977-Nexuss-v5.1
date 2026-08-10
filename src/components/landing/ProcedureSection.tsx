"use client";

export default function ProcedureSection() {
  const steps = [
    {
      number: "01",
      title: "CONNECT",
      description: "Connect your APIs, AI models, databases, and external tools into a unified layer.",
    },
    {
      number: "02",
      title: "CONFIGURE",
      description: "Securely configure API keys, authentication, permissions, and connection settings.",
    },
    {
      number: "03",
      title: "ORCHESTRATE",
      description: "Manage how your AI services communicate through a unified infrastructure layer.",
    },
    {
      number: "04",
      title: "BUILD",
      description: "Use your connected infrastructure to build and ship intelligent applications faster.",
    },
  ];

  return (
    <section id="procedure" className="py-24 px-4 sm:px-6 lg:px-8 bg-black border-t border-neutral-900">
      <div className="max-w-7xl mx-auto space-y-20">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <div className="text-xs font-mono text-neutral-400 uppercase tracking-widest">
            ONE LAYER. EVERY CONNECTION.
          </div>
          <h2 className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight">
            How NEXUSS Works
          </h2>
          <p className="text-neutral-400 text-base sm:text-lg">
            NEXUSS simplifies the infrastructure required to connect modern AI applications.
          </p>
        </div>

        {/* Video Placeholder Container Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
          <div className="relative group aspect-video rounded-2xl bg-neutral-950 border border-neutral-800 overflow-hidden flex flex-col items-center justify-center p-6 text-center shadow-2xl transition-all duration-300 hover:border-neutral-700">
            <div className="absolute inset-0 bg-gradient-to-br from-neutral-900/40 via-transparent to-neutral-950 pointer-events-none" />
            <div className="w-16 h-16 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-white mb-4 group-hover:scale-110 group-hover:bg-white group-hover:text-black transition-all duration-300 shadow-lg">
              <svg className="w-6 h-6 ml-1" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-neutral-200 tracking-wider uppercase font-mono">
              [ VIDEO PLACEHOLDER ]
            </span>
            <span className="text-xs font-mono text-neutral-500 mt-1">
              NEXUSS Infrastructure Integration Demo
            </span>
          </div>

          <div className="relative group aspect-video rounded-2xl bg-neutral-950 border border-neutral-800 overflow-hidden flex flex-col items-center justify-center p-6 text-center shadow-2xl transition-all duration-300 hover:border-neutral-700">
            <div className="absolute inset-0 bg-gradient-to-br from-neutral-900/40 via-transparent to-neutral-950 pointer-events-none" />
            <div className="w-16 h-16 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-white mb-4 group-hover:scale-110 group-hover:bg-white group-hover:text-black transition-all duration-300 shadow-lg">
              <svg className="w-6 h-6 ml-1" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-neutral-200 tracking-wider uppercase font-mono">
              [ VIDEO PLACEHOLDER ]
            </span>
            <span className="text-xs font-mono text-neutral-500 mt-1">
              Multi-Model Orchestration & Context Stream
            </span>
          </div>
        </div>

        {/* 4 Process Cards */}
        <div className="pt-8 space-y-10">
          <div className="border-b border-neutral-900 pb-6 flex flex-col sm:flex-row justify-between items-start sm:items-end gap-2">
            <div>
              <span className="text-xs font-mono text-neutral-500 uppercase tracking-widest block mb-1">
                PROCEDURE STEPS
              </span>
              <h3 className="text-2xl font-bold text-white tracking-tight">Four Step Process</h3>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {steps.map((step) => (
              <div
                key={step.number}
                className="relative bg-neutral-950/80 border border-neutral-800/90 rounded-xl p-6 flex flex-col justify-between hover:border-neutral-700 transition-all duration-300 group hover:-translate-y-1"
              >
                <div>
                  <div className="flex items-center justify-between mb-6">
                    <span className="text-xs font-mono text-neutral-300 font-bold bg-neutral-900 px-3 py-1 rounded border border-neutral-800">
                      {step.number}
                    </span>
                    <span className="w-2 h-2 rounded-full bg-neutral-700 group-hover:bg-white transition-colors" />
                  </div>
                  <h4 className="text-base font-bold text-white tracking-wider mb-2 font-mono">
                    {step.title}
                  </h4>
                  <p className="text-sm text-neutral-400 leading-relaxed">
                    {step.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
