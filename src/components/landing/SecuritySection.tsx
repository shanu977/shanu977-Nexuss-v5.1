"use client";

export default function SecuritySection() {
  const securityCards = [
    {
      title: "Encrypted Connections",
      description: "All connections are enforced using TLS 1.3 encryption protocols.",
      icon: "🔒",
    },
    {
      title: "Secure API Keys",
      description: "API keys are encrypted at rest and never exposed to unauthorized clients.",
      icon: "🔑",
    },
    {
      title: "Access Controls",
      description: "Role-based access rules and strict user identity validation.",
      icon: "🛡️",
    },
    {
      title: "Environment Management",
      description: "Separate keys and endpoints for development, staging, and production.",
      icon: "⚡",
    },
    {
      title: "Audit Logs",
      description: "Detailed logging of connection events, authentication attempts, and usage.",
      icon: "📊",
    },
    {
      title: "Permission Management",
      description: "Fine-grained permissions to manage service access across teams.",
      icon: "👁️",
    },
  ];

  return (
    <section id="security" className="py-24 px-4 sm:px-6 lg:px-8 bg-black border-t border-neutral-900">
      <div className="max-w-7xl mx-auto space-y-16">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <span className="text-xs font-mono text-neutral-400 uppercase tracking-widest block">
            SECURITY & GOVERNANCE
          </span>
          <h2 className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight">
            Your Connections. Your Control.
          </h2>
          <p className="text-neutral-400 text-base sm:text-lg">
            Enterprise-grade controls to protect your infrastructure at every layer.
          </p>
        </div>

        {/* 6 Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {securityCards.map((item, idx) => (
            <div
              key={idx}
              className="bg-neutral-950/80 border border-neutral-800/90 hover:border-neutral-700 rounded-xl p-6 transition-all duration-300 group hover:-translate-y-1 shadow-lg"
            >
              <div className="w-10 h-10 rounded-lg bg-neutral-900 border border-neutral-800 flex items-center justify-center text-xl mb-4 group-hover:scale-110 group-hover:bg-white/10 transition-all">
                {item.icon}
              </div>
              <h3 className="text-lg font-bold text-white tracking-wide mb-2">
                {item.title}
              </h3>
              <p className="text-sm text-neutral-400 leading-relaxed">
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
