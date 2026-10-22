/**
 * Job package entry (init container `seed` and main container `runner`).
 * #34 only pins the workspace wiring; the seed and runner arrive in #39 and
 * both read the shared contract module — they never guess its values.
 */
export const JOB_ENTRY = "not-implemented (#34 wires the workspace; #39 implements seed and runner)";
