// A narrow, immediate fallback for unmistakable first-person distress.
// More nuanced urgency is still evaluated in the review stage.
export function immediateEmergency(message: string): boolean {
  const text = message.toLowerCase().replace(/[’‘]/g, "'");
  const directDistress = /\b(?:i am|i'm|im)\s+(?:dying|going to die)\b/.test(text)
    && !/\bdying\s+(?:to|from laughter|of laughter|of boredom)\b/.test(text);
  const breathing = /\b(?:i (?:can't|cannot) breathe|i am not able to breathe|i'm not able to breathe)\b/.test(text);
  const chestPain = /\b(?:i (?:have|am having)|i'm having)\s+(?:sudden |severe |crushing )*(?:chest pain|chest pressure)\b/.test(text);
  const stroke = /\b(?:i (?:think i am|think i'm|am)|i'm)\s+(?:having a stroke|having a heart attack)\b/.test(text);
  const overdose = /\b(?:i (?:just )?overdosed|i (?:have|just) taken an overdose)\b/.test(text);
  return directDistress || breathing || chestPain || stroke || overdose;
}

export const EMERGENCY_MESSAGE = "Call emergency services now. Do not wait for this app to assess your symptoms. Bangladesh: 999; US/Canada: 911; UK: 999. Elsewhere, call your local emergency number. If possible, tell someone nearby and do not drive yourself.";
