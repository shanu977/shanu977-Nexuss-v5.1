"use client";

import { useState } from "react";

export default function DeveloperSection() {
  const [activeTab, setActiveTab] = useState<"ts" | "python">("ts");

  const tsCode = `import { NexussClient } from "@nexuss/sdk";

const nexuss = new NexussClient({
  apiKey: process.env.NEXUSS_API_KEY || "your_api_key",
});

const connection = await nexuss.connect({
  service: "openai-gpt4",
  endpoint: "/api/v1/connect",
});

console.log("Status:", connection.status);`;

  const pythonCode = `from nexuss import NexussClient

client = NexussClient(api_key="your_api_key")

connection = client.connect(
    service="openai-gpt4",
    endpoint="/api/v1/connect"
)

print("Status:", connection.status)`;

  return (
    <section className="py-24 px-4 sm:px-6 lg:px-8 bg-black border-t border-neutral-900">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
        {/* LEFT COLUMN: Code Editor Mockup */}
        <div className="rounded-2xl bg-neutral-950 border border-neutral-800 shadow-2xl overflow-hidden font-mono text-xs">
          {/* Top Bar */}
          <div className="flex items-center justify-between bg-neutral-900/90 px-4 py-3 border-b border-neutral-800">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-neutral-700" />
              <div className="w-3 h-3 rounded-full bg-neutral-700" />
              <div className="w-3 h-3 rounded-full bg-neutral-700" />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setActiveTab("ts")}
                className={`px-3 py-1 rounded text-xs transition-colors cursor-pointer ${
                  activeTab === "ts"
                    ? "bg-white text-black font-semibold"
                    : "text-neutral-400 hover:text-white"
                }`}
              >
                TypeScript
              </button>
              <button
                onClick={() => setActiveTab("python")}
                className={`px-3 py-1 rounded text-xs transition-colors cursor-pointer ${
                  activeTab === "python"
                    ? "bg-white text-black font-semibold"
                    : "text-neutral-400 hover:text-white"
                }`}
              >
                Python
              </button>
            </div>
          </div>

          {/* Code Body */}
          <div className="p-5 text-neutral-300 bg-neutral-950 overflow-x-auto">
            <pre className="leading-relaxed font-mono">
              <code>{activeTab === "ts" ? tsCode : pythonCode}</code>
            </pre>
          </div>

          {/* Footer Bar */}
          <div className="px-5 py-2.5 bg-neutral-900/50 border-t border-neutral-800/80 text-[11px] text-neutral-500 flex justify-between items-center font-mono">
            <span>NEXUSS SDK EXAMPLE</span>
            <span className="text-emerald-400">READY</span>
          </div>
        </div>

        {/* RIGHT COLUMN: Text & Stat Cards */}
        <div className="space-y-8">
          <div className="space-y-4">
            <span className="text-xs font-mono text-neutral-400 uppercase tracking-widest block">
              DEVELOPER EXPERIENCE
            </span>
            <h2 className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight leading-tight">
              Built for Developers.
            </h2>
            <p className="text-neutral-400 text-base sm:text-lg leading-relaxed">
              Simple interfaces. Powerful infrastructure. Designed to disappear into your stack.
            </p>
          </div>

          {/* Two Stat Cards */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-neutral-950 border border-neutral-800 p-5 rounded-xl space-y-1">
              <div className="text-2xl sm:text-3xl font-extrabold text-white font-mono">&lt; 5min</div>
              <div className="text-[11px] font-mono text-neutral-400 uppercase tracking-wider">
                TIME TO FIRST CONNECTION
              </div>
            </div>
            <div className="bg-neutral-950 border border-neutral-800 p-5 rounded-xl space-y-1">
              <div className="text-2xl sm:text-3xl font-extrabold text-white font-mono">100+</div>
              <div className="text-[11px] font-mono text-neutral-400 uppercase tracking-wider">
                SUPPORTED SERVICES
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
