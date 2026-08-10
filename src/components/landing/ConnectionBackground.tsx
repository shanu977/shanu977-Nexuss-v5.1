"use client";

import { useEffect, useRef } from "react";

interface Node {
  x: number;
  y: number;
  baseX: number;
  baseY: number;
  label: string;
  angle: number;
  distance: number;
  speed: number;
  pulseOffset: number;
}

export default function ConnectionBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let width = (canvas.width = canvas.parentElement?.clientWidth || window.innerWidth);
    let height = (canvas.height = canvas.parentElement?.clientHeight || window.innerHeight);

    const isMobile = width < 768;

    const labels = [
      "AI",
      "API",
      "LLM",
      "MODEL",
      "STREAM",
      "DATA",
      "AUTH",
      "VECTOR",
      "INFRA",
      "CONTEXT",
      "CACHE",
      "ROUTER",
    ];

    const count = isMobile ? 8 : 12;
    const coreRadius = isMobile ? 42 : 65;

    let hubX = width / 2;
    let hubY = height / 2.1;

    // Initialize nodes positioned in radial orbitals around the central core
    const nodes: Node[] = Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      const distance = isMobile
        ? 130 + Math.random() * 100
        : 220 + Math.random() * 180;
      const baseX = hubX + Math.cos(angle) * distance;
      const baseY = hubY + Math.sin(angle) * distance;

      return {
        x: baseX,
        y: baseY,
        baseX,
        baseY,
        label: labels[i % labels.length],
        angle,
        distance,
        speed: (Math.random() * 0.002 + 0.001) * (i % 2 === 0 ? 1 : -1),
        pulseOffset: Math.random() * Math.PI * 2,
      };
    });

    const handleResize = () => {
      if (!canvas || !canvas.parentElement) return;
      width = canvas.width = canvas.parentElement.clientWidth;
      height = canvas.height = canvas.parentElement.clientHeight;
      hubX = width / 2;
      hubY = height / 2.1;
    };

    window.addEventListener("resize", handleResize);

    let time = 0;

    const render = () => {
      time += 0.015;
      ctx.clearRect(0, 0, width, height);

      // --- 1. Draw Central Black AI Core ---
      const corePulse = Math.sin(time * 1.5) * 2;
      const currentCoreRadius = coreRadius + corePulse;

      // Subtle Outer Ambient Glow Ring
      const outerGlow = ctx.createRadialGradient(
        hubX,
        hubY,
        currentCoreRadius * 0.8,
        hubX,
        hubY,
        currentCoreRadius * 2.2
      );
      outerGlow.addColorStop(0, "rgba(255, 255, 255, 0.06)");
      outerGlow.addColorStop(0.5, "rgba(255, 255, 255, 0.02)");
      outerGlow.addColorStop(1, "rgba(0, 0, 0, 0)");

      ctx.beginPath();
      ctx.arc(hubX, hubY, currentCoreRadius * 2.2, 0, Math.PI * 2);
      ctx.fillStyle = outerGlow;
      ctx.fill();

      // Core Outer Border Ring
      ctx.beginPath();
      ctx.arc(hubX, hubY, currentCoreRadius + 4, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Core Dark Surface Separation (Black Hole Body)
      const coreGrad = ctx.createRadialGradient(
        hubX - currentCoreRadius * 0.3,
        hubY - currentCoreRadius * 0.3,
        currentCoreRadius * 0.1,
        hubX,
        hubY,
        currentCoreRadius
      );
      coreGrad.addColorStop(0, "#121212");
      coreGrad.addColorStop(0.7, "#080808");
      coreGrad.addColorStop(1, "#000000");

      ctx.beginPath();
      ctx.arc(hubX, hubY, currentCoreRadius, 0, Math.PI * 2);
      ctx.fillStyle = coreGrad;
      ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
      ctx.shadowBlur = 30;
      ctx.fill();
      ctx.shadowBlur = 0; // reset

      // Inner Core Accent Ring
      ctx.beginPath();
      ctx.arc(hubX, hubY, currentCoreRadius - 10, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Center Core Emblem Dot
      ctx.beginPath();
      ctx.arc(hubX, hubY, 3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
      ctx.fill();

      // --- 2. Draw Surrounding Nodes & Curved Connection Lines ---
      nodes.forEach((node) => {
        // Orbital drift
        node.angle += node.speed;
        node.x = hubX + Math.cos(node.angle) * node.distance + Math.sin(time + node.pulseOffset) * 6;
        node.y = hubY + Math.sin(node.angle) * node.distance + Math.cos(time + node.pulseOffset) * 6;

        // Calculate control point for elegant curved string toward center
        const midX = (node.x + hubX) / 2 + Math.sin(time + node.angle) * 20;
        const midY = (node.y + hubY) / 2 + Math.cos(time + node.angle) * 20;

        // Draw curved connecting line
        ctx.beginPath();
        ctx.moveTo(node.x, node.y);
        ctx.quadraticCurveTo(midX, midY, hubX, hubY);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Flowing signal pulse along line moving TOWARD central core
        const pulsePos = (Math.sin(time * 1.8 + node.pulseOffset) + 1) / 2;
        // Quadratic bezier point formula: (1-t)^2 P0 + 2(1-t)t P1 + t^2 P2
        const t = pulsePos;
        const px = (1 - t) * (1 - t) * node.x + 2 * (1 - t) * t * midX + t * t * hubX;
        const py = (1 - t) * (1 - t) * node.y + 2 * (1 - t) * t * midY + t * t * hubY;

        ctx.beginPath();
        ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
        ctx.fill();

        // Node dot
        const nodePulse = Math.sin(time * 3 + node.pulseOffset) * 0.8;
        ctx.beginPath();
        ctx.arc(node.x, node.y, Math.max(2, 3.5 + nodePulse), 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
        ctx.fill();

        // Node border halo
        ctx.beginPath();
        ctx.arc(node.x, node.y, 8, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Tech Label
        ctx.font = "10px Inter, monospace, sans-serif";
        ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
        ctx.fillText(node.label, node.x + 12, node.y + 4);
      });

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
      <canvas ref={canvasRef} className="w-full h-full opacity-80" />
      {/* Gradient vignette for readability */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black pointer-events-none" />
    </div>
  );
}
