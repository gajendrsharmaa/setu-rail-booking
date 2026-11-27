import type { Itinerary } from "./yatraiq-engine";

/* Client for the stitched itinerary PDF. The document is generated on the
   server/Worker with pdf-lib so the browser only downloads the result. */

export class ItineraryPdfError extends Error {
  code: string;
  status?: number;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = "ItineraryPdfError";
    this.code = code;
    this.status = status;
  }
}

export async function downloadItineraryPdf(
  itinerary: Itinerary,
  notes?: string[]
): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/itinerary/pdf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itinerary, notes }),
    });
  } catch {
    throw new ItineraryPdfError(
      "The booking API is offline, so the itinerary PDF could not be created.",
      "BACKEND_OFFLINE"
    );
  }

  if (!response.ok) {
    throw new ItineraryPdfError(
      `The itinerary PDF could not be created (HTTP ${response.status}).`,
      `HTTP_${response.status}`,
      response.status
    );
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeName = `${itinerary.legs[0]?.from?.code ?? "Yatra"}-${itinerary.legs[itinerary.legs.length - 1]?.to?.code ?? "IQ"}`;
  link.href = url;
  link.download = `RailBandhu-YatraIQ-${safeName}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
