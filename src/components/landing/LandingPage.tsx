"use client";

import LandingNavbar from "./LandingNavbar";
import HeroSection from "./HeroSection";
import ProcedureSection from "./ProcedureSection";
import TechnologySection from "./TechnologySection";
import ApiInfrastructureSection from "./ApiInfrastructureSection";
import DeveloperSection from "./DeveloperSection";
import SecuritySection from "./SecuritySection";
import FinalCTA from "./FinalCTA";
import LandingFooter from "./LandingFooter";

interface LandingPageProps {
  onNavigateAuth: () => void;
}

export default function LandingPage({ onNavigateAuth }: LandingPageProps) {
  return (
    <div className="min-h-screen bg-black text-white selection:bg-white selection:text-black font-sans antialiased overflow-x-hidden">
      <LandingNavbar onNavigateAuth={onNavigateAuth} />
      <main>
        <HeroSection onNavigateAuth={onNavigateAuth} />
        <ProcedureSection />
        <TechnologySection />
        <ApiInfrastructureSection />
        <DeveloperSection />
        <SecuritySection />
        <FinalCTA onNavigateAuth={onNavigateAuth} />
      </main>
      <LandingFooter onNavigateAuth={onNavigateAuth} />
    </div>
  );
}
