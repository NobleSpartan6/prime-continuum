/**
 * Versioned capability names are kept schema-free so lightweight clients can
 * negotiate features without loading the host protocol validator graph.
 */
export const RUNTIME_INTEGRITY_CAPABILITY = "runtime_integrity_v1" as const;
export const RUNTIME_INTEGRITY_RETRY_CAPABILITY = "runtime_integrity_retry_v1" as const;
export const RUNTIME_INTEGRITY_REPAIR_CAPABILITY = "runtime_integrity_repair_v1" as const;
export const RUNTIME_MODEL_CATALOG_CAPABILITY = "runtime_model_catalog_v1" as const;
export const RUNTIME_OAUTH_CAPABILITY = "runtime_oauth_v1" as const;
export const RUNTIME_OAUTH_ATTEMPT_CAPABILITY = "runtime_oauth_attempt_v1" as const;
export const PRIME_AGENT_COMMAND_CAPABILITY = "prime_agent_commands_v2" as const;
/** Exact session-reported thinking levels with generation-fenced selection. */
export const PRIME_AGENT_THINKING_LEVELS_CAPABILITY =
  "prime_agent_thinking_levels_v1" as const;
export const RESIDENT_EXTENSION_UI_CAPABILITY = "resident_extension_ui_v1" as const;
export const RESIDENT_LIFECYCLE_CAPABILITY = "resident_lifecycle_v1" as const;
export const RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY =
  "resident_registered_workspace_lifecycle_v1" as const;
export const RESIDENT_CONTROL_PROJECTION_CAPABILITY = "resident_control_projection_v1" as const;
export const THREAD_HANDOFF_CAPABILITY = "thread_handoff_v1" as const;
/** Trusted-local probe only; executable self-evaluation remains workspace-scoped. */
export const CANDIDATE_EVALUATION_PROBE_CAPABILITY = "candidate_evaluation_probe_v1" as const;
export const PRIME_CONTINUIM_SELF_BUILD_EVALUATION_CAPABILITY =
  "prime_continuim_self_build_evaluation_v1" as const;
