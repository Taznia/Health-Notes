import { PhoneCall } from "lucide-react";

export function EmergencyActions({ compact = false }: { compact?: boolean }) {
  return <div className={`emergency-actions ${compact ? "compact" : ""}`} role="alert">
    <div className="emergency-title"><PhoneCall size={19} /><strong>Call emergency services now</strong></div>
    <p>Do not wait for an AI review. Choose the number for where you are, or use your local emergency number elsewhere.</p>
    <div className="emergency-links">
      <a href="tel:999">Bangladesh · 999</a>
      <a href="tel:911">US / Canada · 911</a>
      <a href="tel:999">UK · 999</a>
    </div>
    <small>If possible, tell someone nearby and do not drive yourself.</small>
  </div>;
}
