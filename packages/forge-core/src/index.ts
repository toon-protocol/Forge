/**
 * @toon-protocol/forge-core — factory engine.
 *
 * Wraps `@ai-hero/sandcastle` with a manifest loader (`factory.toml` per
 * FACTORY_SPEC.md, #213), inner-gate injection (#215), and full
 * label→plan→implement→inner-gates→review→PR orchestration (#216).
 *
 * This is the scaffold stub (#212): shape only, no behaviour yet.
 */

/** Placeholder for the resolved factory manifest (`factory.toml`). See #213. */
export interface FactoryManifest {
  /** Registry-authoritative factory name; must match a `FACTORY.md` row. */
  readonly name: string;
}

/** forge-core semantic version, surfaced for `forge doctor`/`status`. */
export const FORGE_CORE_VERSION = "0.0.0";
