// Creatures' ways drawn over the world (NAVIGATION.md, *Debug*): from each creature that follows a
// planned way, a line through its waypoints still ahead. Single player only - it reads the page's own
// server - and redrawn every frame while shown.
import { Color4, MeshBuilder, Vector3, type LinesMesh, type Scene } from "@babylonjs/core";
import type { Entity } from "../sim/entity";

/** Lines this far over the ground, so they are not lost in it. */
const LIFT = 0.3;
const COLOR = new Color4(0.2, 1, 0.9, 1);

export interface NavDebug {
  dispose(): void;
}

/** Draws the ways of the creatures `creatures` gives, every frame, until disposed. */
export function createNavDebug(scene: Scene, creatures: () => readonly Entity[]): NavDebug {
  let mesh: LinesMesh | null = null;
  /** The points in each line of `mesh`: a mesh is updated in place while they stay the same, since
   *  a new one's shader is not ready in its first frame, and one made every frame is never drawn. */
  let shape = "";
  const frame = (): void => {
    const lines: Vector3[][] = [];
    const colors: Color4[][] = [];
    for (const e of creatures()) {
      const brain = e.creature?.brain;
      if (!brain || brain.path.length === 0 || e.combat?.dead) continue;
      const line = [new Vector3(e.x, e.y + LIFT, e.z), ...brain.path.slice(brain.next).map((p) => new Vector3(p.x, p.y + LIFT, p.z))];
      if (line.length < 2) continue;
      lines.push(line);
      colors.push(line.map(() => COLOR));
    }
    const now = lines.map((l) => l.length).join(",");
    if (mesh && now === shape) {
      MeshBuilder.CreateLineSystem("navPaths", { lines, instance: mesh }, scene);
      return;
    }
    mesh?.dispose();
    mesh = null;
    shape = now;
    if (lines.length === 0) return;
    mesh = MeshBuilder.CreateLineSystem("navPaths", { lines, colors, updatable: true }, scene);
    mesh.isPickable = false;
  };
  const observer = scene.onBeforeRenderObservable.add(frame);
  const disposed = scene.onDisposeObservable.add(() => dispose());
  function dispose(): void {
    scene.onBeforeRenderObservable.remove(observer);
    scene.onDisposeObservable.remove(disposed);
    mesh?.dispose();
    mesh = null;
    shape = "";
  }
  return { dispose };
}
