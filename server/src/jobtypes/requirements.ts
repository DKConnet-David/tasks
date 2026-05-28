import type { JobType } from "../types.js";

/**
 * Per-job-type requirements the field tech is expected to capture.
 *
 * When the `requirements_check_enabled` setting is on, the AI evaluates
 * each item below against the submitted photos + tech notes and emits a
 * found/missing/unclear verdict per requirement. Result stays admin-only:
 * the verdicts surface in the admin SubmissionDetail UI only — not in
 * WhatsApp / Splynx / PDF.
 *
 * Editing this file changes the prompt the AI sees on the next submission.
 * Empty arrays mean "no fixed checklist for this job type" and the AI
 * skips the check entirely (saves tokens).
 */
export const JOB_TYPE_REQUIREMENTS: Record<JobType, string[]> = {
  ftua_installation: [
    "Antenna mounting photographed from ground level showing the full outdoor install",
    "Router placement photo (indoor)",
    "Plugs photo — both antenna PSU and router PSU visible",
    "Full cable run photo (2–3m of cable visible)",
    "LOS shot from antenna location (antenna visible or, for long poles, taken as close to the antenna as possible)",
    "Cabled speedtest from a laptop after install",
    "GPS pin-drop screenshot of the install site coordinates",
  ],
  site_survey: [
    "Tech notes describe what was surveyed / scoped / discussed with the client",
    "Photos of possible router mounting / placement locations",
    "Photos of cable runs that were discussed",
  ],
  fibre_los_inspection: [
    "Clear photo of the top of the ONT",
    "Clear photo of the bottom of the ONT",
    "Proof the fibre patch cable was unplugged, inspected, and reseated",
    "Photos of the visible drop-cable run, with any damaged sections identified",
    "Power-meter readings at each accessible point (patch cord, ONT side, splice box, AP)",
    "Light-source photos at each accessible point",
  ],
  layer2_fibre_setup: [
    "Clear photo of the top of the ONT (ZF or OS)",
    "Clear photo of the bottom of the ONT (ZF or OS)",
    "Router placement and cable management photo",
    "Cabled speedtest results, run from a laptop",
    "Notes identify any additional hardware needed or problematic coverage areas",
  ],
  extender_installation: [
    "Photos of the extender installed in place",
    "Photos of the cable run (for cabled extenders)",
    "Cabled speedtest results from both routers",
    "Before/after wifi coverage check using a wifi-survey app",
    "Notes identify any remaining degraded-signal areas and proposed solutions",
  ],
  antenna_move: [
    "Photos of hardware removed at the previous residence",
    "Photos of any holes closed / cable removed or left in place at the previous residence",
    "GPS pin drop at both the old and the new address",
    "Antenna mounting photographed from ground level at the new address",
    "Router placement photo at the new address",
    "Plugs photo (antenna PSU + router PSU)",
    "Full cable run photo at the new address",
    "LOS shot from the new antenna location",
    "Cabled speedtest from a laptop at the new address",
  ],
  offline_connection: [
    "Photos showing the root cause of the offline connection",
    "Photos showing the resolution (replaced cable / PSU / PoE / etc.)",
    "Photos of any replacement hardware used",
    "Cabled speedtest from a laptop after the connection was restored",
  ],
  internal_issues_callout: [
    "Photos of the devices experiencing issues with make, model, IP, and MAC visible",
    "Photos of wireless signal readings in the identified problem areas",
    "Cabled speedtest from a laptop at the main router",
    "Wireless speedtests in each identified problem area",
    "Notes propose a resolution (additional routers, mounting suggestions, etc.)",
    "Comparison testing using the client's device vs the tech's device in the same area",
  ],
  voip_installation: [
    "VoIP phone details captured: make, model, IP, MAC, serial (where available)",
    "Photo of the VoIP phone installed in its final placement",
    "Photo proof of an incoming and an outgoing call tested on site",
    "Cable management photos (for cabled VoIP)",
    "Wireless coverage tests done (for wifi VoIP)",
    "Photo of the cordless base + charger placement (for cordless phones)",
  ],
  complaint: [],
  other: [],
  // Zoom-billable overrides have no AI requirements check — they're
  // tech-driven classifications, not AI-driven, and the billable
  // nature of the job means we trust the tech's pick. Operator can
  // add checklists here later if they want auditing of these jobs.
  zoom_fibre_install: [],
  zoom_ont_drop: [],
  zoom_reinstall: [],
};

/** True if this job_type has any required items the AI should evaluate. */
export function hasChecklist(jobType: JobType): boolean {
  return (JOB_TYPE_REQUIREMENTS[jobType] ?? []).length > 0;
}
