// Shared by the Expert turns and the Quick check. Kept apart from turns.ts so
// the workflow bundle, which runs Quick orchestration, does not import its tools.
export const VERDICT_INSTRUCTIONS =
  "Choose verdadero if the evidence supports the claim; falso if it contradicts it; no_verificable (Insostenible) if it is not enough to support or refute it; or enganoso (Engañoso) if it presents partial or out-of-context data that leads to a wrong conclusion.";

// Questions are answered with the same codes (Sí, No, Depende and No sé) and dato.
export const ANSWER_INSTRUCTIONS =
  "Choose verdadero (Sí) if the evidence supports answering yes; falso (No) if it supports answering no; enganoso (Depende) if the answer depends on conditions or interpretation, or the question is debated without consensus; no_verificable (No sé) if the evidence is not enough to answer it, including a question that asks for an opinion, advice or a forecast the evidence cannot settle; or dato (Dato) if the question asks for a fact or a figure (a number, a date, a name, a place...) rather than yes or no, and the evidence gives it.";