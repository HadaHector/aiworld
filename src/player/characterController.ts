import { Color3, MeshBuilder, StandardMaterial, Vector3, type ArcRotateCamera, type Mesh, type Scene } from "@babylonjs/core";
import { DEFAULT_MOTOR, type MotorSettings } from "../world/collision/index";
import type { BodyInput } from "../sim/playerBody";
import type { EntityMotion } from "../sim/protocol";
import { createInput } from "./input";
import type { PlayerBody } from "../game/playerBody";

export interface Character {
  mesh: Mesh;
  /** The capsule the server walks the player as (see sim/playerBody.ts) - its size, for drawing it
   *  and for putting it down by a wall. */
  settings: MotorSettings;
  /** What the player wants this frame, from the keys and the camera: a direction in the world's x
   *  and z - forward is where the camera looks - running, and a jump (taken once per press). */
  readIntent: (camera: ArcRotateCamera) => BodyInput;
  /** Draws the player where the server says it is - lying, when dead. */
  show: (state: EntityMotion, dead?: boolean) => void;
  /** Plays a melee swing: the server says when (an ability's `animation` action). */
  swing: () => void;
  /** Draws the player with a body (game/playerBody.ts) instead of the capsule, which stays as the
   *  place the camera and the lights follow. */
  attachBody: (body: PlayerBody) => void;
  dispose: () => void;
}

/**
 * The player as the client sees it: a capsule drawn wherever the server has its body, turned the
 * way it last moved - and the keys (WASD or the arrows, Shift to run, Space to jump) turned into
 * what it wants, relative to the camera. Where it actually goes is the server's business (see
 * SIMULATION.md).
 */
export function createCharacter(scene: Scene, start: { x: number; y: number; z: number }): Character {
  const settings = { ...DEFAULT_MOTOR };
  const { height, radius } = settings;
  const mesh = MeshBuilder.CreateCapsule("player", { height, radius }, scene);
  const material = new StandardMaterial("playerMaterial", scene);
  material.diffuseColor = new Color3(0.2, 0.5, 0.9);
  // The sky and the sun, and the few house lights nearest it (lighting/playerLights.ts).
  material.maxSimultaneousLights = 6;
  mesh.material = material;
  mesh.isPickable = false;
  mesh.position.set(start.x, start.y + height / 2, start.z);

  const input = createInput();
  const forward = new Vector3();
  const right = new Vector3();

  function readIntent(camera: ArcRotateCamera): BodyInput {
    const axis = input.getMoveAxis();
    camera.getDirectionToRef(Vector3.Forward(), forward);
    forward.y = 0;
    forward.normalize();
    camera.getDirectionToRef(Vector3.Right(), right);
    right.y = 0;
    right.normalize();
    return {
      moveX: forward.x * axis.y + right.x * axis.x,
      moveZ: forward.z * axis.y + right.z * axis.x,
      run: input.running(),
      jump: input.takeJump(),
    };
  }

  let body: PlayerBody | null = null;
  function show(state: EntityMotion, dead = false): void {
    mesh.position.set(state.x, state.y + height / 2, state.z);
    mesh.rotation.y = state.facing;
    body?.show({ ...state, dead });
  }

  return {
    mesh,
    settings,
    readIntent,
    show,
    swing: () => body?.swing(),
    attachBody(attached) {
      body?.dispose();
      body = attached;
      mesh.isVisible = false;
    },
    dispose() {
      input.dispose();
      body?.dispose();
    },
  };
}
