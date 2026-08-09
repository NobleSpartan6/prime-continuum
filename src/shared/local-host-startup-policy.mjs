// The release smoke must prove core health before the desktop gives up on the
// same bundled hostd launch. Keep a full second for spawn/scheduling variance;
// the smoke clock starts before spawn while the desktop clock starts after it.
export const LOCAL_HOSTD_DESKTOP_START_DEADLINE_MS = 8_000
export const LOCAL_HOSTD_SMOKE_FIRST_HEALTH_DEADLINE_MS = 7_000
export const LOCAL_HOSTD_MINIMUM_ASSURANCE_MARGIN_MS = 1_000
