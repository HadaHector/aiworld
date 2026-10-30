import { createServer, type Server } from "../sim/server";
import { createLocalChannel, type ClientEnd } from "../sim/channel";
import type { DimensionWorld } from "../sim/dimension";
import type { Welcome } from "../sim/protocol";
import { packSetFrom, type PackSet } from "../world/content/loadContent";
import type { PackSource } from "../world/content/resolveContent";
import type { WorldContent } from "../world/content/worldContent";
import type { WorldConfig } from "../world/content/worldConfig";
import { checkPlacements, resolveGameRules, type GameRules } from "../sim/rules/gameRules";
import { resolveItemRules, type ItemRules } from "../sim/rules/itemRules";
import { resolveCreatureRules, type CreatureRules } from "../sim/rules/creatureRules";
import { checkProgressionItems, resolveProgressionRules, type ProgressionRules } from "../sim/rules/progressionRules";
import { checkSkillRefs } from "../sim/rules/skillRules";
import { resolveFeedback, type FeedbackRules } from "../feedback/rules";
import type { SaveStore } from "../save/store";
import type { WorldRecord } from "../save/records";

/** Everything a world's seed and config make of the packs: what both the client and its server read. */
export interface WorldRules {
  packSet: PackSet;
  /** The start dimension's content. */
  startContent: WorldContent;
  game: GameRules;
  items: ItemRules;
  creatures: CreatureRules;
  progression: ProgressionRules;
  feedback: FeedbackRules;
}

/**
 * Resolves a world's rules from the packs: stats and templates, then creatures and progression
 * (their kinds and classes depend on the seed and join the templates), then items, which check
 * both. Throws a ContentError listing what is wrong with the packs.
 */
export function resolveWorldRules(sources: readonly PackSource[], config: WorldConfig, seed: number): WorldRules {
  const packSet = packSetFrom(sources, config);
  const startContent = packSet.resolve(null);
  // Stats, resources and entity templates (see ENTITIES.md): once for the world, not per dimension.
  const game = resolveGameRules(packSet.sources);
  checkPlacements(game, startContent.dimensions);
  // Creatures (see CREATURES.md): kinds depend on the world seed, and join the templates before the
  // item rules check their loot.
  const creatures = resolveCreatureRules(packSet.sources, game, seed);
  // Progression (see PROGRESSION.md): generated disciplines and classes depend on the world seed, and
  // the origins' combinations join the templates before the item rules check their start items.
  const progression = resolveProgressionRules(packSet.sources, game, seed);
  // Items (see ITEMS.md): generated types depend on the world seed; the skills items name are checked.
  const items = resolveItemRules(packSet.sources, game, seed);
  checkSkillRefs(game, items.abilityRefs);
  checkProgressionItems(progression, items);
  // Sounds, particle effects and cues (see FEEDBACK.md), checked against the skills and the looks.
  const feedback = resolveFeedback(packSet.sources, game);
  return { packSet, startContent, game, items, creatures, progression, feedback };
}

/**
 * A connection to a world's server (FRONTEND.md, *Handshake*). Today always single player: the
 * server runs in the page, over an in-memory channel - the same server `npm run server` runs on its
 * own (see SIMULATION.md). It outlasts a session: logging out returns to its character list.
 */
export interface Connection {
  readonly seed: number;
  readonly rules: WorldRules;
  readonly client: ClientEnd;
  /** The server in the page. */
  readonly server: Server;
  /** Whether the world and its characters are saved. */
  readonly saved: boolean;
  /** Hands the server the page's build of a dimension it asked for, rather than it generating the
   *  same again (see DIMENSIONS.md). */
  provide: (dimension: string, world: DimensionWorld) => void;
  /** Writes the world and every character in it now. */
  save: () => Promise<void>;
  /** Lets the server go: what is in it is saved as it goes. */
  close: () => void;
}

export interface LocalWorld {
  /** Every pack's files, fetched once for the page. */
  sources: readonly PackSource[];
  config: WorldConfig;
  seed: number;
  /** Where the world is saved; left out, nothing is (a quick game, `?play`). */
  saves?: { store: SaveStore; world: WorldRecord; interval?: number };
}

/** Starts a world's server in the page and connects to it. Throws a ContentError for broken packs. */
export function connectLocal(world: LocalWorld): Connection {
  const seed = world.seed >>> 0;
  const rules = resolveWorldRules(world.sources, world.config, seed);
  const built = new Map<string, (world: DimensionWorld) => void>();
  const server = createServer({
    seed,
    config: world.config.name,
    packs: rules.packSet.packs,
    dimensions: rules.startContent.dimensions,
    rules: rules.game,
    items: rules.items,
    creatures: rules.creatures,
    progression: rules.progression,
    loadDimension: (definition) => new Promise<DimensionWorld>((resolve) => built.set(definition.id, resolve)),
    saves: world.saves && { store: world.saves.store, world: world.saves.world, interval: world.saves.interval },
  });
  const channel = createLocalChannel();
  server.connect(channel.server);
  return {
    seed,
    rules,
    client: channel.client,
    server,
    saved: world.saves !== undefined,
    provide(dimension, built_) {
      built.get(dimension)?.(built_);
      built.delete(dimension);
    },
    save: () => server.save(),
    close() {
      channel.client.close();
      server.step(0);
    },
  };
}

/** What differs between a server's Welcome and the rules this page made - warnings, as names may
 *  show wrong, not reasons to stop. */
export function welcomeProblems(welcome: Welcome, seed: number, rules: WorldRules): string[] {
  const problems: string[] = [];
  if (welcome.seed !== seed) problems.push(`The server's world seed (${welcome.seed}) differs from this page's (${seed}): generated content will not match.`);
  if (welcome.creatures !== rules.creatures.hash) problems.push(`The server's creatures (${welcome.creatures.toString(16)}) differ from this page's (${rules.creatures.hash.toString(16)}): creatures may show as the wrong kinds.`);
  if (welcome.items !== rules.items.hash) problems.push(`The server's item rules (${welcome.items.toString(16)}) differ from this page's (${rules.items.hash.toString(16)}): items may show as the wrong things.`);
  if (welcome.progression !== rules.progression.hash) problems.push(`The server's progression (${welcome.progression.toString(16)}) differs from this page's (${rules.progression.hash.toString(16)}): disciplines and talents may show under the wrong names.`);
  if (welcome.rules !== rules.game.hash) problems.push(`The server's game rules (${welcome.rules.toString(16)}) differ from this page's (${rules.game.hash.toString(16)}): stats and resources may show under the wrong names.`);
  return problems;
}
